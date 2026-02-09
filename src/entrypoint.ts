/**
 * Agent Society Container Entrypoint
 *
 * Starts the following services:
 * 1. Nostr Relay Server (WebSocket)
 * 2. Business Logic Server (HTTP) with SPSP handling
 * 3. Bootstrap Service (layered discovery: genesis + ArDrive + env var peers)
 * 4. Social Peer Discovery (dynamic peer expansion via NIP-02 follow lists)
 *
 * Environment Variables:
 * - NODE_ID: Unique identifier for this node
 * - NOSTR_SECRET_KEY: 64-char hex secret key
 * - ILP_ADDRESS: This node's ILP address (e.g., g.peer1)
 * - BTP_ENDPOINT: This node's BTP WebSocket endpoint
 * - BLS_PORT: HTTP port for BLS (default: 3100)
 * - WS_PORT: WebSocket port for relay (default: 7100)
 * - CONNECTOR_ADMIN_URL: URL for connector's Admin API
 * - ARDRIVE_ENABLED: Enable/disable ArDrive peer lookup (default: true)
 * - ADDITIONAL_PEERS: JSON array of extra peers beyond genesis list
 * - ASSET_CODE: Asset code (default: USD)
 * - ASSET_SCALE: Asset scale (default: 6)
 * - BASE_PRICE_PER_BYTE: Base price per byte (default: 10)
 * - AGENT_RUNTIME_URL: URL for agent-runtime POST /ilp/send (optional; enables ILP-first flow)
 * - SUPPORTED_CHAINS: Comma-separated chain identifiers (e.g., "evm:base:8453")
 * - SETTLEMENT_ADDRESS_*: Settlement address per chain (e.g., SETTLEMENT_ADDRESS_EVM_BASE_8453=0x...)
 * - PREFERRED_TOKEN_*: Preferred token per chain
 * - TOKEN_NETWORK_*: Token network address per chain
 * - SETTLEMENT_TIMEOUT: Settlement timeout in seconds
 * - INITIAL_DEPOSIT: Initial deposit amount
 */

import { serve, type ServerType } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { getPublicKey } from 'nostr-tools/pure';
import {
  BootstrapService,
  RelayMonitor,
  createAgentRuntimeClient,
  NostrSpspServer,
  SocialPeerDiscovery,
  buildSpspResponseEvent,
  buildIlpPeerInfoEvent,
  parseSpspRequest,
  type ConnectorAdminClient,
  type BootstrapEvent,
  type IlpPeerInfo,
  type SpspInfo,
  type SpspRequestSettlementInfo,
  SPSP_REQUEST_KIND,
} from '@agent-society/core';
import {
  SqliteEventStore,
  NostrRelayServer,
  PricingService,
  decodeEventFromToon,
  encodeEventToToon,
  generateFulfillment,
  ILP_ERROR_CODES,
  type EventStore,
  type HandlePaymentRequest,
  type HandlePaymentAcceptResponse,
  type HandlePaymentRejectResponse,
} from '@agent-society/relay';
import crypto from 'crypto';

// Environment configuration
export interface Config {
  nodeId: string;
  secretKey: Uint8Array;
  pubkey: string;
  ilpAddress: string;
  btpEndpoint: string;
  blsPort: number;
  wsPort: number;
  connectorAdminUrl: string;
  ardriveEnabled: boolean;
  additionalPeersJson: string | undefined;
  relayUrls: string[];
  assetCode: string;
  assetScale: number;
  basePricePerByte: bigint;
  agentRuntimeUrl: string | undefined;
  settlementInfo: SpspRequestSettlementInfo | undefined;
  spspMinPrice: bigint | undefined;
}

/**
 * Parse configuration from environment variables.
 */
export function parseConfig(): Config {
  const env = process.env;

  const nodeId = env['NODE_ID'];
  if (!nodeId) {
    throw new Error('NODE_ID environment variable is required');
  }

  const secretKeyHex = env['NOSTR_SECRET_KEY'];
  if (!secretKeyHex || secretKeyHex.length !== 64) {
    throw new Error('NOSTR_SECRET_KEY must be a 64-character hex string');
  }
  const secretKey = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
  const pubkey = getPublicKey(secretKey);

  const ilpAddress = env['ILP_ADDRESS'];
  if (!ilpAddress) {
    throw new Error('ILP_ADDRESS environment variable is required');
  }

  const btpEndpoint = env['BTP_ENDPOINT'] || `ws://${nodeId}:3000`;

  const blsPort = parseInt(env['BLS_PORT'] || '3100', 10);
  const wsPort = parseInt(env['WS_PORT'] || '7100', 10);

  const connectorAdminUrl = env['CONNECTOR_ADMIN_URL'] || `http://${nodeId}:8081`;

  const ardriveEnabled = env['ARDRIVE_ENABLED'] !== 'false';
  const additionalPeersJson = env['ADDITIONAL_PEERS'] || undefined;
  const relayUrls = [`ws://localhost:${wsPort}`];

  const assetCode = env['ASSET_CODE'] || 'USD';
  const assetScale = parseInt(env['ASSET_SCALE'] || '6', 10);
  const basePricePerByte = BigInt(env['BASE_PRICE_PER_BYTE'] || '10');

  // ILP-first flow: agent-runtime URL (optional)
  const agentRuntimeUrl = env['AGENT_RUNTIME_URL'] || undefined;
  if (agentRuntimeUrl) {
    try {
      new URL(agentRuntimeUrl);
    } catch {
      throw new Error(`AGENT_RUNTIME_URL is not a valid URL: ${agentRuntimeUrl}`);
    }
  }

  // Settlement info (optional, only when SUPPORTED_CHAINS is set)
  let settlementInfo: SpspRequestSettlementInfo | undefined;
  const supportedChainsStr = env['SUPPORTED_CHAINS'];
  if (supportedChainsStr) {
    const supportedChains = supportedChainsStr.split(',').map((s) => s.trim()).filter(Boolean);
    const settlementAddresses: Record<string, string> = {};
    const preferredTokens: Record<string, string> = {};

    for (const chain of supportedChains) {
      // Convert chain id to env var key: "evm:base:8453" -> "EVM_BASE_8453"
      const envKey = chain.replace(/:/g, '_').toUpperCase();
      const addr = env[`SETTLEMENT_ADDRESS_${envKey}`];
      if (addr) settlementAddresses[chain] = addr;
      const token = env[`PREFERRED_TOKEN_${envKey}`];
      if (token) preferredTokens[chain] = token;
    }

    // Warn for chains without a settlement address
    for (const chain of supportedChains) {
      if (!settlementAddresses[chain]) {
        console.warn(`[Config] Warning: chain "${chain}" listed in SUPPORTED_CHAINS but no SETTLEMENT_ADDRESS_* env var found`);
      }
    }

    settlementInfo = {
      ilpAddress,
      supportedChains,
      ...(Object.keys(settlementAddresses).length > 0 && { settlementAddresses }),
      ...(Object.keys(preferredTokens).length > 0 && { preferredTokens }),
    };
  }

  // SPSP minimum price (optional, bootstrap nodes set to 0)
  let spspMinPrice: bigint | undefined;
  const spspMinPriceStr = env['SPSP_MIN_PRICE'];
  if (spspMinPriceStr !== undefined && spspMinPriceStr !== '') {
    try {
      spspMinPrice = BigInt(spspMinPriceStr);
    } catch {
      throw new Error(`SPSP_MIN_PRICE is not a valid integer: ${spspMinPriceStr}`);
    }
  }

  return {
    nodeId,
    secretKey,
    pubkey,
    ilpAddress,
    btpEndpoint,
    blsPort,
    wsPort,
    connectorAdminUrl,
    ardriveEnabled,
    additionalPeersJson,
    relayUrls,
    assetCode,
    assetScale,
    basePricePerByte,
    agentRuntimeUrl,
    settlementInfo,
    spspMinPrice,
  };
}

/**
 * Generate fresh SPSP parameters for a receiver.
 */
function generateSpspInfo(ilpAddress: string): SpspInfo {
  // Generate unique payment pointer
  const paymentId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const destinationAccount = `${ilpAddress}.spsp.${paymentId}`;

  // Generate 32-byte shared secret
  const sharedSecretBytes = crypto.randomBytes(32);
  const sharedSecret = sharedSecretBytes.toString('base64');

  return {
    destinationAccount,
    sharedSecret,
  };
}

/**
 * Docker-specific admin client interface with required removePeer.
 * Extends ConnectorAdminClient making removePeer non-optional since
 * the Docker entrypoint always implements both addPeer and removePeer.
 */
export interface DockerConnectorAdminClient extends ConnectorAdminClient {
  removePeer(peerId: string): Promise<void>;
}

/**
 * Create an HTTP connector admin client matching the ConnectorAdminClient interface.
 */
export function createConnectorAdminClient(adminUrl: string): DockerConnectorAdminClient {
  return {
    async addPeer(config: {
      id: string;
      url: string;
      authToken: string;
      routes?: { prefix: string; priority?: number }[];
    }): Promise<void> {
      const response = await fetch(`${adminUrl}/peers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to add peer: ${response.status} ${text}`);
      }
    },

    async removePeer(peerId: string): Promise<void> {
      const response = await fetch(`${adminUrl}/peers/${peerId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to remove peer: ${response.status} ${text}`);
      }
    },
  };
}

/**
 * Create the BLS HTTP server with SPSP handling.
 */
function createBlsServer(
  config: Config,
  eventStore: EventStore,
  pricingService: PricingService,
  getBootstrapPhase?: () => string
): Hono {
  const app = new Hono();

  // Health check endpoint
  app.get('/health', (c: Context) => {
    return c.json({
      status: 'healthy',
      nodeId: config.nodeId,
      pubkey: config.pubkey,
      ilpAddress: config.ilpAddress,
      timestamp: Date.now(),
      ...(getBootstrapPhase && { bootstrapPhase: getBootstrapPhase() }),
    });
  });

  // Handle payment endpoint
  app.post('/handle-payment', async (c: Context) => {
    try {
      const body = (await c.req.json()) as HandlePaymentRequest;

      // Validate required fields
      if (!body.amount || !body.destination || !body.data) {
        const response: HandlePaymentRejectResponse = {
          accept: false,
          code: ILP_ERROR_CODES.BAD_REQUEST,
          message: 'Missing required fields: amount, destination, data',
        };
        return c.json(response, 400);
      }

      // Decode base64 data
      let toonBytes: Uint8Array;
      try {
        toonBytes = Uint8Array.from(Buffer.from(body.data, 'base64'));
      } catch {
        const response: HandlePaymentRejectResponse = {
          accept: false,
          code: ILP_ERROR_CODES.BAD_REQUEST,
          message: 'Invalid base64 encoding in data field',
        };
        return c.json(response, 400);
      }

      // Decode TOON to Nostr event
      let event;
      try {
        event = decodeEventFromToon(toonBytes);
      } catch (error) {
        const response: HandlePaymentRejectResponse = {
          accept: false,
          code: ILP_ERROR_CODES.BAD_REQUEST,
          message: `Invalid TOON data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
        return c.json(response, 400);
      }

      // Calculate price
      const price = pricingService.calculatePriceFromBytes(toonBytes, event.kind);
      const amount = BigInt(body.amount);

      // Check if this is an SPSP request (kind:23194)
      if (event.kind === SPSP_REQUEST_KIND) {
        // Verify payment meets price
        if (amount < price) {
          const response: HandlePaymentRejectResponse = {
            accept: false,
            code: ILP_ERROR_CODES.INSUFFICIENT_AMOUNT,
            message: 'Insufficient payment for SPSP request',
            metadata: {
              required: price.toString(),
              received: amount.toString(),
            },
          };
          return c.json(response, 400);
        }

        // Parse and handle SPSP request
        try {
          const spspRequest = parseSpspRequest(event, config.secretKey, event.pubkey);

          // Generate fresh SPSP parameters
          const spspInfo = generateSpspInfo(config.ilpAddress);

          // Build encrypted response
          const responseEvent = buildSpspResponseEvent(
            {
              requestId: spspRequest.requestId,
              destinationAccount: spspInfo.destinationAccount,
              sharedSecret: spspInfo.sharedSecret,
            },
            event.pubkey,
            config.secretKey,
            event.id
          );

          // Encode response as TOON for fulfillment data
          const responseToon = encodeEventToToon(responseEvent);
          const responseData = Buffer.from(responseToon).toString('base64');

          const response: HandlePaymentAcceptResponse = {
            accept: true,
            fulfillment: generateFulfillment(event.id),
            metadata: {
              eventId: event.id,
              storedAt: Date.now(),
            },
          };

          // Include response event data in the response
          return c.json({
            ...response,
            data: responseData,
          });
        } catch (error) {
          const response: HandlePaymentRejectResponse = {
            accept: false,
            code: ILP_ERROR_CODES.BAD_REQUEST,
            message: `Failed to process SPSP request: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
          return c.json(response, 400);
        }
      }

      // For other event kinds, verify payment and store
      // Self-write bypass: owner events skip payment verification
      if (event.pubkey !== config.pubkey) {
        if (amount < price) {
          const response: HandlePaymentRejectResponse = {
            accept: false,
            code: ILP_ERROR_CODES.INSUFFICIENT_AMOUNT,
            message: 'Insufficient payment amount',
            metadata: {
              required: price.toString(),
              received: amount.toString(),
            },
          };
          return c.json(response, 400);
        }
      }

      // Store the event
      eventStore.store(event);

      const response: HandlePaymentAcceptResponse = {
        accept: true,
        fulfillment: generateFulfillment(event.id),
        metadata: {
          eventId: event.id,
          storedAt: Date.now(),
        },
      };

      return c.json(response);
    } catch (error) {
      const response: HandlePaymentRejectResponse = {
        accept: false,
        code: ILP_ERROR_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Internal server error',
      };
      return c.json(response, 500);
    }
  });

  return app;
}

/**
 * Wait for agent-runtime to become healthy before proceeding with bootstrap.
 */
export async function waitForAgentRuntime(
  url: string,
  options?: { timeout?: number; interval?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 60000;
  const interval = options?.interval ?? 2000;
  const healthUrl = `${url}/health`;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
      console.log(`[Bootstrap] Agent-runtime not ready (HTTP ${response.status}), retrying...`);
    } catch {
      console.log(`[Bootstrap] Agent-runtime not reachable at ${healthUrl}, retrying...`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Agent-runtime health check timed out after ${timeout}ms: ${url}`);
}

/**
 * Main entrypoint.
 */
async function main(): Promise<void> {
  console.log('\n' + '='.repeat(50));
  console.log('Agent Society Container Starting');
  console.log('='.repeat(50) + '\n');

  // Parse configuration
  const config = parseConfig();
  console.log(`[Config] Node ID: ${config.nodeId}`);
  console.log(`[Config] Pubkey: ${config.pubkey.slice(0, 16)}...`);
  console.log(`[Config] ILP Address: ${config.ilpAddress}`);
  console.log(`[Config] BTP Endpoint: ${config.btpEndpoint}`);
  console.log(`[Config] ArDrive Enabled: ${config.ardriveEnabled}`);

  // Initialize event store (in-memory for containers)
  const eventStore = new SqliteEventStore(':memory:');
  console.log('[Setup] Initialized in-memory event store');

  // Initialize pricing service
  const spspPrice = config.spspMinPrice !== undefined
    ? config.spspMinPrice
    : config.basePricePerByte / 2n;
  const pricingService = new PricingService({
    basePricePerByte: config.basePricePerByte,
    kindOverrides: new Map([
      [SPSP_REQUEST_KIND, spspPrice], // kind:23194
    ]),
  });
  console.log(`[Setup] Pricing: ${config.basePricePerByte} units/byte`);

  // Set up bootstrap service early so health endpoint can report phase
  const bootstrapService = new BootstrapService(
    {
      knownPeers: [],
      ardriveEnabled: config.ardriveEnabled,
      defaultRelayUrl: `ws://localhost:${config.wsPort}`,
      ...(config.agentRuntimeUrl && { agentRuntimeUrl: config.agentRuntimeUrl }),
      ...(config.settlementInfo && { settlementInfo: config.settlementInfo }),
      ownIlpAddress: config.ilpAddress,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      basePricePerByte: config.basePricePerByte,
    },
    config.secretKey,
    {
      ilpAddress: config.ilpAddress,
      btpEndpoint: config.btpEndpoint,
      assetCode: config.assetCode,
      assetScale: config.assetScale,
    }
  );

  // Create and start BLS HTTP server (pass bootstrap phase getter for health endpoint)
  const blsApp = createBlsServer(config, eventStore, pricingService, () => bootstrapService.getPhase());
  const blsServer: ServerType = serve({
    fetch: blsApp.fetch,
    port: config.blsPort,
  });
  console.log(`[Setup] BLS listening on http://0.0.0.0:${config.blsPort}`);

  // Start WebSocket relay
  const wsRelay = new NostrRelayServer({ port: config.wsPort }, eventStore);
  await wsRelay.start();
  console.log(`[Setup] Relay listening on ws://0.0.0.0:${config.wsPort}`);

  // Wait a moment for relay to be fully ready
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Set up SPSP server for direct requests (not ILP-routed)
  // This handles SPSP requests that come via Nostr directly
  const spspServer = new NostrSpspServer(
    [`ws://localhost:${config.wsPort}`],
    config.secretKey
  );
  const spspSubscription = spspServer.handleSpspRequests(() => {
    return generateSpspInfo(config.ilpAddress);
  });
  console.log('[Setup] SPSP server started');

  // Bootstrap with layered peer discovery (genesis + ArDrive + env var)
  const ownIlpInfo: IlpPeerInfo = {
    ilpAddress: config.ilpAddress,
    btpEndpoint: config.btpEndpoint,
    assetCode: config.assetCode,
    assetScale: config.assetScale,
  };

  const adminClient = createConnectorAdminClient(config.connectorAdminUrl);

  console.log('\n[Bootstrap] Starting bootstrap process...');
  bootstrapService.setConnectorAdmin(adminClient);

  // Wire up agent-runtime client for ILP-first flow
  if (config.agentRuntimeUrl) {
    const agentRuntimeClient = createAgentRuntimeClient(config.agentRuntimeUrl);
    bootstrapService.setAgentRuntimeClient(agentRuntimeClient);
    console.log(`[Bootstrap] ILP-first flow enabled via ${config.agentRuntimeUrl}`);
  }

  // Register bootstrap event listener for logging
  bootstrapService.on((event: BootstrapEvent) => {
    switch (event.type) {
      case 'bootstrap:phase':
        console.log(`[Bootstrap] Phase: ${event.previousPhase || 'init'} -> ${event.phase}`);
        break;
      case 'bootstrap:peer-registered':
        console.log(`[Bootstrap] Peer registered: ${event.peerId} (${event.ilpAddress})`);
        break;
      case 'bootstrap:channel-opened':
        console.log(`[Bootstrap] Channel opened: ${event.channelId} with ${event.peerId} on ${event.negotiatedChain}`);
        break;
      case 'bootstrap:handshake-failed':
        console.warn(`[Bootstrap] Handshake failed for ${event.peerId}: ${event.reason}`);
        break;
      case 'bootstrap:announced':
        console.log(`[Bootstrap] Announced to ${event.peerId} (eventId: ${event.eventId}, amount: ${event.amount})`);
        break;
      case 'bootstrap:announce-failed':
        console.warn(`[Bootstrap] Announce failed for ${event.peerId}: ${event.reason}`);
        break;
      case 'bootstrap:ready':
        console.log(`[Bootstrap] Ready: ${event.peerCount} peers, ${event.channelCount} channels`);
        break;
    }
  });

  // Wait for agent-runtime to be healthy before bootstrapping
  if (config.agentRuntimeUrl) {
    console.log(`[Bootstrap] Waiting for agent-runtime at ${config.agentRuntimeUrl}...`);
    await waitForAgentRuntime(config.agentRuntimeUrl);
    console.log('[Bootstrap] Agent-runtime is healthy');
  }

  let relayMonitorSubscription: { unsubscribe(): void } | undefined;

  try {
    const results = await bootstrapService.bootstrap(config.additionalPeersJson);

    console.log(`[Bootstrap] Peers bootstrapped: ${results.length}`);
    if (config.ardriveEnabled) {
      console.log(`[Bootstrap] ArDrive peer lookup was enabled`);
    }

    if (results.length === 0) {
      // No peers found — running as bootstrap node
      console.log('[Bootstrap] No peers found - running as bootstrap node');
      console.log('[Bootstrap] Publishing own ILP info to local relay');
      try {
        const ilpInfoEvent = buildIlpPeerInfoEvent(ownIlpInfo, config.secretKey);
        eventStore.store(ilpInfoEvent);
        console.log('[Bootstrap] ILP info published successfully');
        console.log(`[Bootstrap] Event ID: ${ilpInfoEvent.id.slice(0, 16)}...`);
      } catch (error) {
        console.warn('[Bootstrap] Failed to publish ILP info:', error);
      }
    }

    // Start RelayMonitor to discover new peers on our relay
    if (config.agentRuntimeUrl) {
      const relayMonitor = new RelayMonitor(
        {
          relayUrl: `ws://localhost:${config.wsPort}`,
          secretKey: config.secretKey,
          toonEncoder: encodeEventToToon,
          toonDecoder: decodeEventFromToon,
          basePricePerByte: config.basePricePerByte,
          settlementInfo: config.settlementInfo,
        }
      );
      relayMonitor.setConnectorAdmin(adminClient);
      relayMonitor.setAgentRuntimeClient(
        createAgentRuntimeClient(config.agentRuntimeUrl)
      );

      // Register same event listener for relay monitor events
      relayMonitor.on((event: BootstrapEvent) => {
        switch (event.type) {
          case 'bootstrap:peer-discovered':
            console.log(`[RelayMonitor] Peer discovered: ${event.peerPubkey.slice(0, 16)}... (${event.ilpAddress})`);
            break;
          case 'bootstrap:peer-registered':
            console.log(`[RelayMonitor] Peer registered: ${event.peerId} (${event.ilpAddress})`);
            break;
          case 'bootstrap:channel-opened':
            console.log(`[RelayMonitor] Channel opened: ${event.channelId} with ${event.peerId} on ${event.negotiatedChain}`);
            break;
          case 'bootstrap:handshake-failed':
            console.warn(`[RelayMonitor] Handshake failed for ${event.peerId}: ${event.reason}`);
            break;
          case 'bootstrap:peer-deregistered':
            console.log(`[RelayMonitor] Peer deregistered: ${event.peerId} (${event.reason})`);
            break;
        }
      });

      const bootstrapPeerPubkeys = results.map((r) => r.knownPeer.pubkey);
      relayMonitorSubscription = relayMonitor.start(bootstrapPeerPubkeys);
      console.log('[RelayMonitor] Started monitoring relay for new peers');
    }
  } catch (error) {
    console.error('[Bootstrap] Bootstrap failed:', error);
  }

  // Start social graph peer discovery
  const socialDiscovery = new SocialPeerDiscovery(
    { relayUrls: config.relayUrls },
    config.secretKey,
    ownIlpInfo
  );
  socialDiscovery.setConnectorAdmin(adminClient);
  const socialSubscription = socialDiscovery.start();
  console.log('[Setup] Social graph discovery started');

  console.log('\n' + '='.repeat(50));
  console.log('Agent Society Container Ready');
  console.log('='.repeat(50) + '\n');

  // Graceful shutdown handling
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Shutdown] Received ${signal}`);

    if (relayMonitorSubscription) {
      relayMonitorSubscription.unsubscribe();
      console.log('[Shutdown] Relay monitor stopped');
    }

    socialSubscription.unsubscribe();
    console.log('[Shutdown] Social discovery stopped');

    spspSubscription.unsubscribe();
    await wsRelay.stop();
    blsServer.close();

    console.log('[Shutdown] Complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Run main only when executed directly (not when imported for testing)
if (process.env['VITEST'] === undefined) {
  main().catch((error) => {
    console.error('[Fatal] Startup error:', error);
    process.exit(1);
  });
}
