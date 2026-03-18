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
import {
  createEventStorageHandler,
} from '@toon-protocol/town';
import {
  BootstrapService,
  createDiscoveryTracker,
  SocialPeerDiscovery,
  buildIlpPeerInfoEvent,
  ILP_PEER_INFO_KIND,
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
import { parseConfig } from './shared.js';

// ---------- Connector Config from Env ----------
interface ConnectorEnv {
  btpServerPort: number;
  settlementRpcUrl: string | undefined;
  settlementPrivateKey: string | undefined;
  settlementRegistryAddress: string | undefined;
  settlementTokenAddress: string | undefined;
}

function parseConnectorEnv(): ConnectorEnv {
  const env = process.env;
  return {
    btpServerPort: parseInt(env['BTP_SERVER_PORT'] || '3000', 10),
    settlementRpcUrl: env['SETTLEMENT_RPC_URL'] || undefined,
    settlementPrivateKey: env['SETTLEMENT_PRIVATE_KEY'] || undefined,
    settlementRegistryAddress: env['SETTLEMENT_REGISTRY_ADDRESS'] || undefined,
    settlementTokenAddress: env['SETTLEMENT_TOKEN_ADDRESS'] || undefined,
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
    addPeer: async (peerConfig) => { await connector.registerPeer(peerConfig as Parameters<typeof connector.registerPeer>[0]); },
    removePeer: async (peerId) => { await connector.removePeer(peerId); },
  });

  // Auto-peer when a new peer is discovered via ILP-delivered kind:10032 events
  discoveryTracker.on((event) => {
    console.log(`[Discovery] Event: ${event.type}${event.type === 'bootstrap:peer-discovered' ? ` pubkey=${(event as { peerPubkey?: string }).peerPubkey?.slice(0, 16)}...` : ''}`);
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
        console.log(`[Discovery] Received kind:10032 from ${decoded.pubkey.slice(0, 16)}..., feeding to tracker`);
        discoveryTracker.processEvent(decoded);
      }
    }
    return result;
  });
  console.log('[Setup] ServiceNode created with embedded connector');

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

  // --- HTTP server (BLS health + handle-packet) ---
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
      embedded: true,
      ...(bootstrapPhase && { bootstrapPhase }),
      ...(bootstrapPhase === 'ready' && {
        peerCount: discoveryTracker.getPeerCount() + peerCount,
        discoveredPeerCount: discoveryTracker.getDiscoveredCount(),
        channelCount,
      }),
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
  console.log(`[Setup] Self-route added: ${config.ilpAddress} → ${config.nodeId}`);

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
