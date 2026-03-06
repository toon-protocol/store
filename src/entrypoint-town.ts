/**
 * SDK-Based Crosstown Container Entrypoint (Town)
 *
 * Replaces the manually-wired entrypoint.ts with SDK pipeline components
 * from @crosstown/sdk and handler implementations from @crosstown/town.
 *
 * Pipeline: size check -> shallow TOON parse -> Schnorr verify -> pricing validate -> handler dispatch
 *
 * Uses Approach A: individual SDK components wired to the BLS HTTP endpoint
 * (external connector mode -- NOT createNode() which assumes embedded connector).
 */

import { serve, type ServerType } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import {
  HandlerRegistry,
  createVerificationPipeline,
  createPricingValidator,
  createHandlerContext,
  fromSecretKey,
} from '@crosstown/sdk';
import type {
  HandlePacketAcceptResponse,
  HandlePacketRejectResponse,
} from '@crosstown/sdk';
import {
  createEventStorageHandler,
  createSpspHandshakeHandler,
} from '@crosstown/town';
import {
  BootstrapService,
  RelayMonitor,
  createAgentRuntimeClient,
  SocialPeerDiscovery,
  buildIlpPeerInfoEvent,
  SPSP_REQUEST_KIND,
} from '@crosstown/core';
import type {
  ConnectorChannelClient,
  SettlementNegotiationConfig,
  BootstrapEvent,
  BootstrapResult,
  IlpPeerInfo,
  HandlePacketRequest,
} from '@crosstown/core';
import {
  shallowParseToon,
  decodeEventFromToon,
  encodeEventToToon,
} from '@crosstown/core/toon';
import { SqliteEventStore, NostrRelayServer } from '@crosstown/relay';
import type { EventStore } from '@crosstown/relay';
import {
  parseConfig,
  createConnectorAdminClient,
  createChannelClient,
  waitForAgentRuntime,
} from './entrypoint.js';

// ---------- SDK Pipeline Constants ----------
const MAX_PAYLOAD_BASE64_LENGTH = 1_048_576;

// ---------- SDK Pipeline Handler ----------
function createPipelineHandler(
  eventStore: EventStore,
  config: ReturnType<typeof parseConfig>,
  settlementConfig: SettlementNegotiationConfig | undefined,
  channelClient: ConnectorChannelClient | undefined,
  adminClient: ReturnType<typeof createConnectorAdminClient> | undefined
) {
  const identity = fromSecretKey(config.secretKey);

  // SDK pipeline components
  const verifier = createVerificationPipeline({ devMode: false });
  const pricer = createPricingValidator({
    basePricePerByte: config.basePricePerByte,
    ownPubkey: identity.pubkey,
    kindPricing: {
      [SPSP_REQUEST_KIND]:
        config.spspMinPrice ?? config.basePricePerByte / 2n,
    },
  });

  // Handler registry with Town handlers
  const registry = new HandlerRegistry();
  registry.onDefault(createEventStorageHandler({ eventStore }));
  registry.on(
    SPSP_REQUEST_KIND,
    createSpspHandshakeHandler({
      secretKey: config.secretKey,
      ilpAddress: config.ilpAddress,
      eventStore,
      settlementConfig,
      channelClient,
      adminClient,
    })
  );

  // TOON decoder for HandlerContext
  const toonDecoder = (toon: string) => {
    const bytes = Buffer.from(toon, 'base64');
    return decodeEventFromToon(bytes);
  };

  return async (
    request: HandlePacketRequest
  ): Promise<HandlePacketAcceptResponse | HandlePacketRejectResponse> => {
    // 1. Size check
    if (request.data.length > MAX_PAYLOAD_BASE64_LENGTH) {
      return { accept: false, code: 'F08', message: 'Payload too large' };
    }

    // 2. Shallow TOON parse
    const toonBytes = Buffer.from(request.data, 'base64');
    let meta;
    try {
      meta = shallowParseToon(toonBytes);
    } catch {
      return { accept: false, code: 'F06', message: 'Invalid TOON payload' };
    }

    // 3. Schnorr signature verification
    const verifyResult = await verifier.verify(meta, request.data);
    if (!verifyResult.verified) {
      if (verifyResult.rejection) {
        return verifyResult.rejection;
      }
      return { accept: false, code: 'F06', message: 'Verification failed' };
    }

    // 4. Pricing validation (with self-write bypass)
    let amount: bigint;
    try {
      amount = BigInt(request.amount);
    } catch {
      return { accept: false, code: 'T00', message: 'Invalid payment amount' };
    }
    const priceResult = pricer.validate(meta, amount);
    if (!priceResult.accepted) {
      if (priceResult.rejection) {
        return priceResult.rejection;
      }
      return {
        accept: false,
        code: 'F04',
        message: 'Pricing validation failed',
      };
    }

    // 5. Build HandlerContext and dispatch
    const ctx = createHandlerContext({
      toon: request.data,
      meta,
      amount,
      destination: request.destination,
      toonDecoder,
    });

    try {
      return await registry.dispatch(ctx);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Handler dispatch failed:', errMsg);
      return { accept: false, code: 'T00', message: 'Internal error' };
    }
  };
}

// ---------- Main ----------
async function main(): Promise<void> {
  console.log('\n' + '='.repeat(50));
  console.log('Crosstown Container Starting (SDK/Town)');
  console.log('='.repeat(50) + '\n');

  const config = parseConfig();
  console.log(`[Config] Node ID: ${config.nodeId}`);
  console.log(`[Config] Pubkey: ${config.pubkey.slice(0, 16)}...`);
  console.log(`[Config] ILP Address: ${config.ilpAddress}`);

  // Initialize stores and services
  const dataDir = process.env['DATA_DIR'] || '/data';
  const dbPath = `${dataDir}/events.db`;
  const eventStore = new SqliteEventStore(dbPath);
  console.log(`[Setup] Initialized event store at ${dbPath}`);

  // Settlement config
  let settlementConfig: SettlementNegotiationConfig | undefined;
  let channelClient: ConnectorChannelClient | undefined;
  if (config.settlementInfo) {
    settlementConfig = {
      ownSupportedChains: config.settlementInfo.supportedChains ?? [],
      ownSettlementAddresses: config.settlementInfo.settlementAddresses ?? {},
      ownPreferredTokens: config.settlementInfo.preferredTokens,
      ownTokenNetworks: config.settlementInfo.tokenNetworks,
      initialDeposit: config.initialDeposit ?? '0',
      settlementTimeout: config.settlementTimeout ?? 86400,
      channelOpenTimeout: 30000,
      pollInterval: 1000,
    };
    channelClient = createChannelClient(config.connectorAdminUrl);
  }

  const adminClient = createConnectorAdminClient(config.connectorAdminUrl);

  // Create SDK pipeline handler
  const handlePacket = createPipelineHandler(
    eventStore,
    config,
    settlementConfig,
    channelClient,
    adminClient
  );
  console.log(
    '[Setup] SDK pipeline wired: size -> parse -> verify -> price -> dispatch'
  );

  // Parse bootstrap peers once (reused by BootstrapService and publishOwnIlpInfo)
  const knownPeers = parseBootstrapPeers(config);

  // BLS HTTP server (Hono)
  const bootstrapService = new BootstrapService(
    {
      knownPeers,
      ardriveEnabled: config.ardriveEnabled,
      defaultRelayUrl: `ws://localhost:${config.wsPort}`,
      ...(config.connectorUrl && { connectorUrl: config.connectorUrl }),
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

  let peerCount = 0;
  let channelCount = 0;

  const app = new Hono();
  app.get('/health', (c: Context) => {
    const bootstrapPhase = bootstrapService.getPhase();
    return c.json({
      status: 'healthy',
      nodeId: config.nodeId,
      pubkey: config.pubkey,
      ilpAddress: config.ilpAddress,
      timestamp: Date.now(),
      sdk: true,
      ...(bootstrapPhase && { bootstrapPhase }),
      ...(bootstrapPhase === 'ready' && { peerCount, channelCount }),
    });
  });

  app.post('/handle-packet', async (c: Context) => {
    try {
      const body = (await c.req.json()) as HandlePacketRequest;
      if (!body.amount || !body.destination || !body.data) {
        return c.json(
          { accept: false, code: 'F00', message: 'Missing required fields' },
          400
        );
      }
      const result = await handlePacket(body);
      return c.json(result, result.accept ? 200 : 400);
    } catch (error) {
      return c.json(
        {
          accept: false,
          code: 'T00',
          message:
            error instanceof Error ? error.message : 'Internal server error',
        },
        500
      );
    }
  });

  const blsServer: ServerType = serve({
    fetch: app.fetch,
    port: config.blsPort,
  });
  console.log(`[Setup] BLS listening on http://0.0.0.0:${config.blsPort}`);

  // Start WebSocket relay
  const wsRelay = new NostrRelayServer({ port: config.wsPort }, eventStore);
  await wsRelay.start();
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- log-only, not a connection; internal Docker network uses ws://
  console.log(`[Setup] Relay listening on ws://0.0.0.0:${config.wsPort}`);
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Bootstrap
  bootstrapService.setConnectorAdmin(adminClient);

  let agentRuntimeClient:
    | ReturnType<typeof createAgentRuntimeClient>
    | undefined;
  if (config.connectorUrl) {
    agentRuntimeClient = createAgentRuntimeClient(config.connectorAdminUrl);
    bootstrapService.setAgentRuntimeClient(agentRuntimeClient);
    console.log(
      `[Bootstrap] ILP-first flow enabled via ${config.connectorAdminUrl}`
    );
  }

  bootstrapService.on((event: BootstrapEvent) => {
    switch (event.type) {
      case 'bootstrap:phase':
        console.log(
          `[Bootstrap] Phase: ${event.previousPhase || 'init'} -> ${event.phase}`
        );
        break;
      case 'bootstrap:peer-registered':
        peerCount++;
        console.log(
          `[Bootstrap] Peer registered: ${event.peerId} (${event.ilpAddress})`
        );
        break;
      case 'bootstrap:channel-opened':
        channelCount++;
        console.log(
          `[Bootstrap] Channel opened: ${event.channelId} with ${event.peerId}`
        );
        break;
      case 'bootstrap:handshake-failed':
        console.warn(
          `[Bootstrap] Handshake failed for ${event.peerId}: ${event.reason}`
        );
        break;
      case 'bootstrap:ready':
        console.log(
          `[Bootstrap] Ready: ${event.peerCount} peers, ${event.channelCount} channels`
        );
        break;
    }
  });

  if (config.connectorUrl) {
    console.log(
      `[Bootstrap] Waiting for agent-runtime at ${config.connectorUrl}...`
    );
    await waitForAgentRuntime(config.connectorUrl);
    console.log('[Bootstrap] Agent-runtime is healthy');
  }

  let relayMonitorSubscription: { unsubscribe(): void } | undefined;

  try {
    const results = await bootstrapService.bootstrap(
      config.additionalPeersJson
    );
    console.log(`[Bootstrap] Peers bootstrapped: ${results.length}`);

    // Publish own ILP info (self-write bypass)
    publishOwnIlpInfo(
      config,
      eventStore,
      knownPeers,
      results,
      agentRuntimeClient
    );

    // Start RelayMonitor
    if (config.connectorUrl) {
      const firstPeer = knownPeers[0];
      const monitorRelayUrl =
        firstPeer?.relayUrl ?? `ws://localhost:${config.wsPort}`;
      const relayMonitor = new RelayMonitor({
        relayUrl: monitorRelayUrl,
        secretKey: config.secretKey,
        toonEncoder: encodeEventToToon,
        toonDecoder: decodeEventFromToon,
        basePricePerByte: config.basePricePerByte,
        settlementInfo: config.settlementInfo,
      });
      relayMonitor.setConnectorAdmin(adminClient);
      relayMonitor.setAgentRuntimeClient(
        createAgentRuntimeClient(config.connectorUrl)
      );
      relayMonitor.on((event: BootstrapEvent) => {
        if (event.type === 'bootstrap:peer-registered') {
          console.log(`[RelayMonitor] Peer registered: ${event.peerId}`);
        }
      });
      const bootstrapPeerPubkeys = results.map((r) => r.knownPeer.pubkey);
      relayMonitorSubscription = relayMonitor.start(bootstrapPeerPubkeys);
      console.log('[RelayMonitor] Started monitoring relay for new peers');
    }
  } catch (error) {
    console.error('[Bootstrap] Bootstrap failed:', error);
  }

  // Social discovery
  const socialDiscovery = new SocialPeerDiscovery(
    { relayUrls: config.relayUrls },
    config.secretKey
  );
  socialDiscovery.on((event) => {
    console.log(
      `[SocialDiscovery] ${event.type}: ${event.pubkey.slice(0, 16)}...`
    );
  });
  const socialSubscription = socialDiscovery.start();

  console.log('\n' + '='.repeat(50));
  console.log('Crosstown Container Ready (SDK/Town)');
  console.log('='.repeat(50) + '\n');

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Shutdown] Received ${signal}`);
    if (relayMonitorSubscription) relayMonitorSubscription.unsubscribe();
    socialSubscription.unsubscribe();
    await wsRelay.stop();
    blsServer.close();
    console.log('[Shutdown] Complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ---------- Helpers ----------
function parseBootstrapPeers(config: ReturnType<typeof parseConfig>) {
  let knownPeers: { pubkey: string; relayUrl: string; btpEndpoint: string }[] =
    [];
  if (config.bootstrapPeersJson) {
    try {
      const parsed = JSON.parse(config.bootstrapPeersJson);
      if (Array.isArray(parsed)) {
        knownPeers = (parsed as unknown[])
          .filter(
            (p): p is Record<string, unknown> =>
              typeof p === 'object' &&
              p !== null &&
              typeof (p as Record<string, unknown>)['pubkey'] === 'string' &&
              typeof (p as Record<string, unknown>)['btpEndpoint'] === 'string'
          )
          .map((p) => ({
            pubkey: p['pubkey'] as string,
            relayUrl: ((p['relay'] as string) ||
              (p['relayUrl'] as string) ||
              `ws://localhost:${config.wsPort}`) as string,
            btpEndpoint: p['btpEndpoint'] as string,
          }));
      }
    } catch (error) {
      console.warn('[Bootstrap] Failed to parse BOOTSTRAP_PEERS:', error);
    }
  }
  return knownPeers;
}

function publishOwnIlpInfo(
  config: ReturnType<typeof parseConfig>,
  eventStore: EventStore,
  knownPeers: { pubkey: string; relayUrl: string; btpEndpoint: string }[],
  results: BootstrapResult[],
  agentRuntimeClient: ReturnType<typeof createAgentRuntimeClient> | undefined
) {
  const ownIlpInfo: IlpPeerInfo = {
    ilpAddress: config.ilpAddress,
    btpEndpoint: config.btpEndpoint,
    assetCode: config.assetCode,
    assetScale: config.assetScale,
    ...(config.settlementInfo?.supportedChains && {
      supportedChains: config.settlementInfo.supportedChains,
    }),
    ...(config.settlementInfo?.settlementAddresses && {
      settlementAddresses: config.settlementInfo.settlementAddresses,
    }),
    ...(config.settlementInfo?.preferredTokens && {
      preferredTokens: config.settlementInfo.preferredTokens,
    }),
    ...(config.settlementInfo?.tokenNetworks && {
      tokenNetworks: config.settlementInfo.tokenNetworks,
    }),
  };

  try {
    const ilpInfoEvent = buildIlpPeerInfoEvent(ownIlpInfo, config.secretKey);
    eventStore.store(ilpInfoEvent);
    console.log('[Bootstrap] Published own ILP info to local relay');

    const firstPeer = knownPeers[0];
    const genesisResult = results[0];
    if (firstPeer && genesisResult && agentRuntimeClient) {
      const genesisIlpAddress = genesisResult.peerInfo.ilpAddress;
      const toonBytes = encodeEventToToon(ilpInfoEvent);
      const base64Toon = Buffer.from(toonBytes).toString('base64');
      const amount = String(BigInt(toonBytes.length) * config.basePricePerByte);

      agentRuntimeClient
        .sendIlpPacket({
          destination: genesisIlpAddress,
          amount,
          data: base64Toon,
        })
        .then(
          (ilpResult: {
            accepted: boolean;
            fulfillment?: string;
            code?: string;
            message?: string;
          }) => {
            if (ilpResult.accepted) {
              console.log(`[Bootstrap] Published to genesis relay via ILP`);
            } else {
              console.warn(
                `[Bootstrap] Genesis relay rejected: ${ilpResult.code} ${ilpResult.message}`
              );
            }
          }
        )
        .catch((err: Error) => {
          console.warn('[Bootstrap] Failed to publish via ILP:', err.message);
        });
    }
  } catch (error) {
    console.warn('[Bootstrap] Failed to publish ILP info:', error);
  }
}

if (process.env['VITEST'] === undefined) {
  main().catch((error) => {
    console.error('[Fatal] Startup error:', error);
    process.exit(1);
  });
}
