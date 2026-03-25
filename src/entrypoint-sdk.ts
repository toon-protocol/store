/**
 * SDK Entrypoint with Embedded Connector
 *
 * Single-container deployment: ConnectorNode + ServiceNode + Relay + BLS.
 * Each peer is fully self-contained — no external connector container needed.
 *
 * Uses createNode() with an embedded ConnectorNode. Bootstrap discovers peers
 * dynamically via knownPeers and self-describing BTP claims.
 *
 * Environment variables (beyond shared.ts parseConfig):
 * - BTP_SERVER_PORT: ConnectorNode BTP listen port (default: 3000)
 * - SETTLEMENT_RPC_URL: Anvil/chain RPC endpoint
 * - SETTLEMENT_PRIVATE_KEY: EVM private key for settlement
 * - SETTLEMENT_REGISTRY_ADDRESS: TokenNetworkRegistry contract address
 * - SETTLEMENT_TOKEN_ADDRESS: ERC-20 token contract address
 */

import { serve, type ServerType } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { createNode, type ServiceNode } from '@toon-protocol/sdk';
import { createEventStorageHandler } from '@toon-protocol/town';
import {
  BootstrapService,
  createDiscoveryTracker,
  SocialPeerDiscovery,
  buildIlpPeerInfoEvent,
  ILP_PEER_INFO_KIND,
  TEE_ATTESTATION_KIND,
  parseAttestation,
  buildAttestationEvent,
} from '@toon-protocol/core';
import type {
  BootstrapEvent,
  IlpPeerInfo,
  EmbeddableConnectorLike,
} from '@toon-protocol/core';
import {
  encodeEventToToon,
  decodeEventFromToon,
} from '@toon-protocol/core/toon';
import { SqliteEventStore, NostrRelayServer } from '@toon-protocol/relay';
import { ConnectorNode, createLogger } from '@toon-protocol/connector';
import {
  createArweaveDvmHandler,
  TurboUploadAdapter,
  ChunkManager,
} from '@toon-protocol/sdk';
import { parseConfig } from './shared.js';

// ---------- Connector Config from Env ----------
interface ConnectorEnv {
  btpServerPort: number;
  settlementRpcUrl: string | undefined;
  settlementPrivateKey: string | undefined;
  settlementRegistryAddress: string | undefined;
  settlementTokenAddress: string | undefined;
  settlementThreshold: string | undefined;
}

function parseConnectorEnv(): ConnectorEnv {
  const env = process.env;
  return {
    btpServerPort: parseInt(env['BTP_SERVER_PORT'] || '3000', 10),
    settlementRpcUrl: env['SETTLEMENT_RPC_URL'] || undefined,
    settlementPrivateKey: env['SETTLEMENT_PRIVATE_KEY'] || undefined,
    settlementRegistryAddress: env['SETTLEMENT_REGISTRY_ADDRESS'] || undefined,
    settlementTokenAddress: env['SETTLEMENT_TOKEN_ADDRESS'] || undefined,
    settlementThreshold: env['SETTLEMENT_THRESHOLD'] || undefined,
  };
}

// ---------- Bootstrap Peers Parser ----------
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

// ---------- Main ----------
async function main(): Promise<void> {
  console.log('\n' + '='.repeat(50));
  console.log('TOON Container Starting (SDK/Embedded)');
  console.log('='.repeat(50) + '\n');

  const config = parseConfig();
  const connectorEnv = parseConnectorEnv();

  console.log(`[Config] Node ID: ${config.nodeId}`);
  console.log(`[Config] Pubkey: ${config.pubkey.slice(0, 16)}...`);
  console.log(`[Config] ILP Address: ${config.ilpAddress}`);
  console.log(`[Config] BTP Server Port: ${connectorEnv.btpServerPort}`);

  // --- EventStore ---
  const dataDir = process.env['DATA_DIR'] || '/data';
  const dbPath = `${dataDir}/events.db`;
  const eventStore = new SqliteEventStore(dbPath);
  console.log(`[Setup] Initialized event store at ${dbPath}`);

  // --- ConnectorNode (embedded) ---
  const connectorLogger = createLogger(config.nodeId, 'info');
  const connector = new ConnectorNode(
    {
      nodeId: config.nodeId,
      btpServerPort: connectorEnv.btpServerPort,
      environment: 'development' as const,
      deploymentMode: 'embedded' as const,
      peers: [],
      routes: [],
      localDelivery: { enabled: false },
      ...(connectorEnv.settlementRpcUrl && {
        settlementInfra: {
          enabled: true,
          rpcUrl: connectorEnv.settlementRpcUrl,
          registryAddress: connectorEnv.settlementRegistryAddress,
          tokenAddress: connectorEnv.settlementTokenAddress,
          privateKey: connectorEnv.settlementPrivateKey,
          ...(connectorEnv.settlementThreshold && {
            threshold: connectorEnv.settlementThreshold,
          }),
        },
      }),
    },
    connectorLogger
  );
  console.log('[Setup] Created embedded ConnectorNode');

  // --- Known peers for bootstrap ---
  const knownPeers = parseBootstrapPeers(config);

  // --- WebSocket Nostr relay (create early so the handler closure can reference it) ---
  const wsRelay = new NostrRelayServer({ port: config.wsPort }, eventStore);

  // --- ServiceNode via createNode() ---
  // Cast: ConnectorNode implements EmbeddableConnectorLike at runtime, but
  // tsc sees Buffer vs Uint8Array in SendPacketParams across package boundaries.
  const node: ServiceNode = createNode({
    secretKey: config.secretKey,
    connector: connector as unknown as EmbeddableConnectorLike,
    ilpAddress: config.ilpAddress,
    btpEndpoint: config.btpEndpoint,
    assetCode: config.assetCode,
    assetScale: config.assetScale,
    basePricePerByte: config.basePricePerByte,
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    knownPeers,
    settlementInfo: config.settlementInfo,
    ardriveEnabled: config.ardriveEnabled,
  });

  // Create a shared discovery tracker for auto-registration of kind:10032 peers
  const discoveryTracker = createDiscoveryTracker({
    secretKey: config.secretKey,
    settlementInfo: config.settlementInfo,
  });

  // Wire connector as admin for the discovery tracker (auto-peering on discovery)
  // ConnectorNode.registerPeer() returns Promise<PeerInfo> but ConnectorAdminClient
  // expects Promise<void>, and settlement.preference types differ (string vs union),
  // so we cast and wrap with void returns.
  discoveryTracker.setConnectorAdmin({
    addPeer: async (peerConfig) => {
      await connector.registerPeer(
        peerConfig as Parameters<typeof connector.registerPeer>[0]
      );
    },
    removePeer: async (peerId) => {
      await connector.removePeer(peerId);
    },
  });

  // Auto-peer when a new peer is discovered via ILP-delivered kind:10032 events
  discoveryTracker.on((event) => {
    console.log(
      `[Discovery] Event: ${event.type}${event.type === 'bootstrap:peer-discovered' ? ` pubkey=${(event as { peerPubkey?: string }).peerPubkey?.slice(0, 16)}...` : ''}`
    );
    if (event.type === 'bootstrap:peer-discovered') {
      discoveryTracker.peerWith(event.peerPubkey).catch((err) => {
        console.warn(
          `[AutoPeer] Failed to peer with ${event.peerPubkey.slice(0, 16)}...: ${err instanceof Error ? err.message : err}`
        );
      });
    }
  });

  // Register default handler: store events, broadcast to WebSocket, and
  // feed kind:10032 events to discovery tracker for auto-registration.
  const storageHandler = createEventStorageHandler({ eventStore });
  node.onDefault(async (ctx) => {
    const result = await storageHandler(ctx);
    const decoded = ctx.decode();
    if (decoded) {
      wsRelay.broadcastEvent(decoded);

      // Feed kind:10032 events to discovery tracker for processing
      if (decoded.kind === ILP_PEER_INFO_KIND) {
        console.log(
          `[Discovery] Received kind:10032 from ${decoded.pubkey.slice(0, 16)}..., feeding to tracker`
        );
        discoveryTracker.processEvent(decoded);
      }
    }
    return result;
  });
  console.log('[Setup] ServiceNode created with embedded connector');

  // --- Arweave DVM handler (kind:5094) ---
  if (config.ardriveEnabled) {
    const chunkManager = new ChunkManager();
    const turboAdapter = new TurboUploadAdapter();
    const arweaveHandler = createArweaveDvmHandler({
      turboAdapter,
      chunkManager,
    });
    node.on(5094, arweaveHandler);
    console.log('[Setup] Arweave DVM handler registered for kind:5094');
  }

  // --- Bootstrap lifecycle ---
  const bootstrapService = new BootstrapService(
    {
      knownPeers,
      ardriveEnabled: config.ardriveEnabled,
      defaultRelayUrl: `ws://localhost:${config.wsPort}`,
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
      case 'bootstrap:settlement-failed':
        console.warn(
          `[Bootstrap] Settlement failed for ${event.peerId}: ${event.reason}`
        );
        break;
      case 'bootstrap:ready':
        console.log(
          `[Bootstrap] Ready: ${event.peerCount} peers, ${event.channelCount} channels`
        );
        break;
    }
  });

  // --- TEE attestation tracking ---
  // When TEE_ENABLED=true, the attestation server (separate process) publishes
  // kind:10033 events to the local relay. We query the event store on each
  // /health request to include the latest attestation state.
  const teeEnabled = process.env['TEE_ENABLED'] === 'true';

  function getTeeHealthInfo(): Record<string, unknown> | undefined {
    if (!teeEnabled) return undefined;
    try {
      // Query event store for latest kind:10033 from our own pubkey
      const events = eventStore.query([
        {
          kinds: [TEE_ATTESTATION_KIND],
          authors: [config.pubkey],
          limit: 1,
        },
      ]);
      if (events.length === 0) {
        return {
          attested: false,
          enclaveType: 'marlin-oyster',
          lastAttestation: 0,
          pcr0: '',
          state: 'unattested' as const,
        };
      }
      const event = events[0]!;
      const parsed = parseAttestation(event);
      if (!parsed) {
        return {
          attested: false,
          enclaveType: 'marlin-oyster',
          lastAttestation: 0,
          pcr0: '',
          state: 'unattested' as const,
        };
      }
      const now = Math.floor(Date.now() / 1000);
      const age = now - event.created_at;
      // Validity: 300s default, grace: 30s
      const state = age <= 300 ? 'valid' : age <= 330 ? 'stale' : 'unattested';
      return {
        attested: state === 'valid' || state === 'stale',
        enclaveType: parsed.attestation.enclave,
        lastAttestation: event.created_at,
        pcr0: parsed.attestation.pcr0,
        state,
      };
    } catch {
      return undefined;
    }
  }

  // --- HTTP server (BLS health + handle-packet) ---
  const app = new Hono();
  app.get('/health', (c: Context) => {
    const bootstrapPhase = bootstrapService.getPhase();
    const tee = getTeeHealthInfo();
    return c.json({
      status: 'healthy',
      nodeId: config.nodeId,
      pubkey: config.pubkey,
      ilpAddress: config.ilpAddress,
      timestamp: Date.now(),
      version: 3,
      sdk: true,
      embedded: true,
      ...(bootstrapPhase && { bootstrapPhase }),
      ...(bootstrapPhase === 'ready' && {
        peerCount: discoveryTracker.getPeerCount() + peerCount,
        discoveredPeerCount: discoveryTracker.getDiscoveredCount(),
        channelCount,
      }),
      ...(tee && { tee }),
    });
  });

  const blsServer: ServerType = serve({
    fetch: app.fetch,
    port: config.blsPort,
  });
  console.log(`[Setup] BLS listening on http://0.0.0.0:${config.blsPort}`);

  // --- Start WebSocket Nostr relay (created earlier for handler closure) ---
  await wsRelay.start();
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- log-only, internal Docker network
  console.log(`[Setup] Relay listening on ws://0.0.0.0:${config.wsPort}`);
  await new Promise((resolve) => setTimeout(resolve, 500));

  // --- Start connector + node ---
  await connector.start();
  console.log('[Setup] ConnectorNode started');

  await node.start();
  console.log('[Setup] ServiceNode started');

  // --- Self-route: tell the connector that our own ILP prefix is local ---
  // After node.start() wires setPacketHandler(), packets matching our ILP
  // address prefix will be delivered to the ServiceNode's handler.
  connector.addRoute({
    prefix: config.ilpAddress,
    nextHop: config.nodeId,
    priority: 100,
  });
  console.log(
    `[Setup] Self-route added: ${config.ilpAddress} → ${config.nodeId}`
  );

  // --- Bootstrap ---
  try {
    const results = await bootstrapService.bootstrap(
      config.additionalPeersJson
    );
    console.log(`[Bootstrap] Peers bootstrapped: ${results.length}`);

    // Build own ILP info for local publish + remote announce
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

    // Publish own ILP info to local relay
    try {
      const ilpInfoEvent = buildIlpPeerInfoEvent(ownIlpInfo, config.secretKey);
      eventStore.store(ilpInfoEvent);
      console.log('[Bootstrap] Published own ILP info to local relay');
    } catch (error) {
      console.warn('[Bootstrap] Failed to publish ILP info:', error);
    }

    // Publish kind:10033 TEE attestation event if TEE is enabled.
    // Stored directly in the event store (relay rejects WebSocket writes
    // as ILP-gated). The attestation server process handles HTTP endpoints
    // (/attestation/raw, /health) but kind:10033 relay publishing is done here.
    if (teeEnabled) {
      try {
        const attestation = {
          enclave: 'marlin-oyster',
          pcr0: '0'.repeat(96),
          pcr1: '0'.repeat(96),
          pcr2: '0'.repeat(96),
          attestationDoc: Buffer.from(
            'placeholder-attestation-document'
          ).toString('base64'),
          version: '1.0.0',
        };
        const refreshSeconds = parseInt(
          process.env['ATTESTATION_REFRESH_INTERVAL'] || '300',
          10
        );
        const externalUrl =
          config.externalRelayUrl || `ws://localhost:${config.wsPort}`;
        const chainId = process.env['TOON_CHAIN'] || '31337';

        const publishAttestation = () => {
          const expiry = Math.floor(Date.now() / 1000) + refreshSeconds * 2;
          const attestEvent = buildAttestationEvent(
            attestation,
            config.secretKey,
            {
              relay: externalUrl,
              chain: chainId,
              expiry,
            }
          );
          eventStore.store(attestEvent);
          wsRelay.broadcastEvent(attestEvent);
          console.log(
            `[TEE] Published kind:10033 attestation (id: ${attestEvent.id.slice(0, 16)}...)`
          );
        };

        publishAttestation();
        setInterval(publishAttestation, refreshSeconds * 1000);
      } catch (err) {
        console.warn('[TEE] Failed to publish attestation event:', err);
      }
    }

    // Mark bootstrap peers as excluded from discovery (already peered).
    // ILP-delivered kind:10032 events are fed to the shared discoveryTracker
    // via the ILP handler above — no WebSocket subscription needed.
    const bootstrapPeerPubkeys = results.map((r) => r.knownPeer.pubkey);
    discoveryTracker.addExcludedPubkeys(bootstrapPeerPubkeys);
    console.log('[DiscoveryTracker] Excluded bootstrap peers from discovery');

    // Announce own ILP info to bootstrap peers via ILP.
    // This stores our kind:10032 on their relay, enabling them to discover
    // and auto-register us for multi-hop routing.
    for (const result of results) {
      try {
        const announceEvent = buildIlpPeerInfoEvent(
          ownIlpInfo,
          config.secretKey
        );
        await node.publishEvent(announceEvent, {
          destination: result.peerInfo.ilpAddress,
        });
        console.log(
          `[Announce] Published ILP info to ${result.peerInfo.ilpAddress}`
        );
      } catch (err) {
        console.warn(
          `[Announce] Failed to announce to ${result.registeredPeerId}: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  } catch (error) {
    console.error('[Bootstrap] Bootstrap failed:', error);
  }

  // --- Social discovery ---
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
  console.log('TOON Container Ready (SDK/Embedded)');
  console.log('='.repeat(50) + '\n');

  // --- Graceful shutdown ---
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Shutdown] Received ${signal}`);
    socialSubscription.unsubscribe();
    await node.stop();
    await connector.stop();
    await wsRelay.stop();
    blsServer.close();
    console.log('[Shutdown] Complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ---------- Helpers ----------

if (process.env['VITEST'] === undefined) {
  main().catch((error) => {
    console.error('[Fatal] Startup error:', error);
    process.exit(1);
  });
}
