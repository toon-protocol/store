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
import {
  createNode,
  type ServiceNode,
} from '@toon-protocol/sdk';
import { createEventStorageHandler } from '@toon-protocol/town';
import {
  BootstrapService,
  createDiscoveryTracker,
  createDirectIlpClient,
  createDirectConnectorAdmin,
  SocialPeerDiscovery,
  buildIlpPeerInfoEvent,
  buildServiceDiscoveryEvent,
  BLOB_STORAGE_REQUEST_KIND,
  ILP_PEER_INFO_KIND,
  TEE_ATTESTATION_KIND,
  parseAttestation,
  buildAttestationEvent,
  resolveChainConfig,
} from '@toon-protocol/core';
import type {
  BootstrapEvent,
  IlpPeerInfo,
  EmbeddableConnectorLike,
  ChainProviderConfigEntry,
} from '@toon-protocol/core';
import {
  encodeEventToToon,
  decodeEventFromToon,
} from '@toon-protocol/core/toon';
import { SqliteEventStore, NostrRelayServer } from '@toon-protocol/relay';
import { ConnectorNode, createLogger } from '@toon-protocol/connector';
import type { ConnectorConfig } from '@toon-protocol/connector';
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
  // Multi-chain env vars
  solanaRpcUrl: string | undefined;
  solanaProgramId: string | undefined;
  solanaKeyId: string | undefined;
  minaGraphqlUrl: string | undefined;
  minaZkAppAddress: string | undefined;
  minaKeyId: string | undefined;
  // NIP-59 env vars
  nip59Enabled: boolean;
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
    // Multi-chain
    solanaRpcUrl: env['SOLANA_RPC_URL'] || undefined,
    solanaProgramId: env['SOLANA_PROGRAM_ID'] || undefined,
    solanaKeyId: env['SOLANA_KEY_ID'] || undefined,
    minaGraphqlUrl: env['MINA_GRAPHQL_URL'] || undefined,
    minaZkAppAddress: env['MINA_ZKAPP_ADDRESS'] || undefined,
    minaKeyId: env['MINA_KEY_ID'] || undefined,
    // NIP-59
    nip59Enabled: env['NIP59_ENABLED'] === 'true',
  };
}

/**
 * Build chainProviders array from multi-chain env vars.
 * Returns undefined if no multi-chain env vars are set.
 */
function buildChainProviders(
  connectorEnv: ConnectorEnv
): ChainProviderConfigEntry[] | undefined {
  const providers: ChainProviderConfigEntry[] = [];

  // EVM provider from existing settlement env vars
  if (connectorEnv.settlementRpcUrl && connectorEnv.settlementRegistryAddress) {
    providers.push({
      chainType: 'evm' as const,
      // Numeric chain id (e.g. evm:84532 Base Sepolia) so the provider matches
      // the `evm:<id>` peer relations and `evm:base:<id>` settlement keys.
      // TOON_CHAIN is a name preset; resolveChainConfig maps it to the number
      // (anvil→31337 when unset), preserving local-mode evm:31337.
      chainId: `evm:${resolveChainConfig(process.env['TOON_CHAIN']).chainId}`,
      rpcUrl: connectorEnv.settlementRpcUrl,
      registryAddress: connectorEnv.settlementRegistryAddress,
      tokenAddress: connectorEnv.settlementTokenAddress ?? '',
      keyId: connectorEnv.settlementPrivateKey || 'evm-settlement',
    });
  }

  // Solana provider
  if (connectorEnv.solanaRpcUrl && connectorEnv.solanaProgramId) {
    providers.push({
      chainType: 'solana' as const,
      chainId: `solana:${process.env['SOLANA_CLUSTER'] || 'devnet'}`,
      rpcUrl: connectorEnv.solanaRpcUrl,
      programId: connectorEnv.solanaProgramId,
      keyId: connectorEnv.solanaKeyId || 'solana-settlement',
    });
  }

  // Mina provider
  if (connectorEnv.minaGraphqlUrl && connectorEnv.minaZkAppAddress) {
    providers.push({
      chainType: 'mina' as const,
      chainId: `mina:${process.env['MINA_NETWORK'] || 'devnet'}`,
      graphqlUrl: connectorEnv.minaGraphqlUrl,
      zkAppAddress: connectorEnv.minaZkAppAddress,
      ...(connectorEnv.minaKeyId && { keyId: connectorEnv.minaKeyId }),
    });
  }

  return providers.length > 0 ? providers : undefined;
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

// ---------- BTP Peers Parser (for ConnectorNode constructor) ----------
interface BtpPeerConfig {
  id: string;
  url: string;
  authToken: string;
  evmAddress?: string;
  chain?: string;
  nip59PublicKey?: string;
}

interface BtpRouteConfig {
  prefix: string;
  nextHop: string;
  priority?: number;
}

function parseBtpPeers() {
  const peers: BtpPeerConfig[] = [];
  const routes: BtpRouteConfig[] = [];

  const peersJson = process.env['BTP_PEERS'];
  if (peersJson) {
    try {
      const parsed = JSON.parse(peersJson);
      if (Array.isArray(parsed)) {
        for (const p of parsed as unknown[]) {
          if (
            typeof p === 'object' &&
            p !== null &&
            typeof (p as Record<string, unknown>)['id'] === 'string' &&
            typeof (p as Record<string, unknown>)['url'] === 'string'
          ) {
            const peer = p as Record<string, unknown>;
            peers.push({
              id: peer['id'] as string,
              url: peer['url'] as string,
              authToken: (peer['authToken'] as string) ?? '',
              ...(peer['evmAddress'] ? { evmAddress: peer['evmAddress'] as string } : {}),
              ...(peer['chain'] ? { chain: peer['chain'] as string } : {}),
              ...(peer['nip59PublicKey'] ? { nip59PublicKey: peer['nip59PublicKey'] as string } : {}),
            });
          }
        }
      }
    } catch (error) {
      console.warn('[BTP] Failed to parse BTP_PEERS:', error);
    }
  }

  const routesJson = process.env['BTP_ROUTES'];
  if (routesJson) {
    try {
      const parsed = JSON.parse(routesJson);
      if (Array.isArray(parsed)) {
        for (const r of parsed as unknown[]) {
          if (
            typeof r === 'object' &&
            r !== null &&
            typeof (r as Record<string, unknown>)['prefix'] === 'string' &&
            typeof (r as Record<string, unknown>)['nextHop'] === 'string'
          ) {
            const route = r as Record<string, unknown>;
            routes.push({
              prefix: route['prefix'] as string,
              nextHop: route['nextHop'] as string,
              priority: (route['priority'] as number | undefined) ?? 0,
            });
          }
        }
      }
    } catch (error) {
      console.warn('[BTP] Failed to parse BTP_ROUTES:', error);
    }
  }

  return { peers, routes };
}

/**
 * Resolve the route addresses advertised OUT OF BAND in the kind:10032
 * announcement content (issue #22). A client holding only the genesis seed can
 * then learn where to PUBLISH (the relay terminate address) and where to STORE
 * (the blob terminate address) without falling back to a hardcoded route map.
 *
 * Defaults are derived from this node's own ILP address (which IS the store
 * terminate, e.g. `g.proxy.store`): the sibling publish route is obtained by
 * swapping the trailing `.store` label for `.relay` (`g.proxy.store` ->
 * `g.proxy.relay`). Both are overridable via env for non-standard topologies.
 */
function resolveAnnouncementRoutes(ilpAddress: string): {
  publish: string;
  store: string;
} {
  const store = process.env['TOON_STORE_ROUTE']?.trim() || ilpAddress;
  const derivedPublish = ilpAddress.endsWith('.store')
    ? `${ilpAddress.slice(0, -'.store'.length)}.relay`
    : ilpAddress;
  const publish = process.env['TOON_PUBLISH_ROUTE']?.trim() || derivedPublish;
  return { publish, store };
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

  // --- BTP peers for ConnectorNode constructor ---
  const { peers: btpPeers, routes: btpRoutes } = parseBtpPeers();
  if (btpPeers.length > 0) {
    console.log(`[BTP] Pre-configured ${btpPeers.length} peer(s) for ConnectorNode constructor`);
    for (const p of btpPeers) {
      console.log(`[BTP]   Peer: ${p.id} @ ${p.url}${p.evmAddress ? ` (evm: ${p.evmAddress})` : ''}${p.chain ? ` [chain: ${p.chain}]` : ''}`);
    }
  }
  if (btpRoutes.length > 0) {
    console.log(`[BTP] Pre-configured ${btpRoutes.length} route(s) for ConnectorNode constructor`);
    for (const r of btpRoutes) {
      console.log(`[BTP]   Route: ${r.prefix} -> ${r.nextHop} (priority: ${r.priority ?? 0})`);
    }
  }

  // --- ConnectorNode (embedded) ---
  const connectorLogger = createLogger(config.nodeId, 'info');

  // Build multi-chain providers from env vars (returns undefined if none set)
  const chainProviders = buildChainProviders(connectorEnv);
  const hasChainProviders = chainProviders !== undefined && chainProviders.length > 0;

  const connector = new ConnectorNode(
    {
      nodeId: config.nodeId,
      btpServerPort: connectorEnv.btpServerPort,
      environment: 'development' as const,
      deploymentMode: 'embedded' as const,
      peers: btpPeers,
      routes: btpRoutes,
      localDelivery: { enabled: false },
      // E2E: disable connector forwarding fee so the full payment amount
      // reaches the destination relay. Prevents F99 Insufficient Payment
      // rejections caused by intermediary connector fee deduction.
      settlement: { connectorFeePercentage: 0 } as unknown as NonNullable<
        ConnectorConfig['settlement']
      >,
      // Multi-chain: chainProviders carry per-chain settlement config (v2.3.0+).
      // When env vars are set but no explicit chainProviders, build from env.
      ...(hasChainProviders
        ? { chainProviders }
        : connectorEnv.settlementRpcUrl && connectorEnv.settlementRegistryAddress
          ? {
              chainProviders: [
                {
                  chainType: 'evm' as const,
                  // Register the EVM provider under its NUMERIC chain id (e.g.
          // evm:84532 for Base Sepolia) so it matches the `evm:<id>` peer
          // relations in BTP_PEERS and the `evm:base:<id>` settlement keys.
          // TOON_CHAIN is a chain-name preset (anvil / base-sepolia / …);
          // resolveChainConfig maps it to the numeric id (anvil→31337 when
          // unset), keeping local mode (evm:31337) unchanged.
          chainId: `evm:${resolveChainConfig(process.env['TOON_CHAIN']).chainId}`,
                  rpcUrl: connectorEnv.settlementRpcUrl,
                  registryAddress: connectorEnv.settlementRegistryAddress,
                  tokenAddress: connectorEnv.settlementTokenAddress ?? '',
                  privateKey: connectorEnv.settlementPrivateKey,
                  keyId: 'evm-settlement',
                },
              ],
            }
          : {}),
      // NIP-59 transport privacy
      ...(connectorEnv.nip59Enabled && { nip59: { enabled: true } }),
    },
    connectorLogger
  );
  console.log('[Setup] Created embedded ConnectorNode');
  if (hasChainProviders) {
    console.log(`[Setup] Multi-chain providers configured: ${chainProviders.map((p) => (p as { chainType: string }).chainType).join(', ')}`);
  }
  if (connectorEnv.nip59Enabled) {
    console.log('[Setup] NIP-59 transport privacy enabled');
  }

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
    settlementInfo: config.settlementInfo,
    ardriveEnabled: config.ardriveEnabled,
    // Omit knownPeers — the external BootstrapService handles bootstrap after
    // node.start() with a wrapped admin client that reuses constructor peerIds.
    // This prevents createToonNode's internal BootstrapService from overwriting
    // constructor-configured peer routes with nostr-... generated IDs.
  });

  // Create a shared discovery tracker for auto-registration of kind:10032 peers
  const discoveryTracker = createDiscoveryTracker({
    secretKey: config.secretKey,
    settlementInfo: config.settlementInfo,
  });

  // Track discovered peerId -> constructor peerId mappings so that removePeer
  // can resolve back to the constructor peerId if we reused one.
  const discoveredToConstructorPeerId = new Map<string, string>();

  /**
   * Check if a discovered peer matches a constructor-configured peer by URL
   * (BTP endpoint) or route prefix. If so, return the constructor peerId
   * so the connector reuses the existing peer registration and payment channel.
   */
  function resolveConstructorPeerId(
    peerConfig: {
      id: string;
      url: string;
      routes?: { prefix: string }[];
      evmAddress?: string;
    }
  ): string | undefined {
    // Match by URL (BTP endpoint)
    const urlMatch = btpPeers.find((p) => p.url === peerConfig.url);
    if (urlMatch) {
      return urlMatch.id;
    }

    // Match by EVM address
    if (peerConfig.evmAddress) {
      const evmMatch = btpPeers.find(
        (p) =>
          p.evmAddress &&
          p.evmAddress.toLowerCase() === peerConfig.evmAddress!.toLowerCase()
      );
      if (evmMatch) {
        return evmMatch.id;
      }
    }

    // Match by route prefix: if a discovered route prefix matches a
    // constructor route, use the constructor route's nextHop as peerId.
    if (peerConfig.routes) {
      for (const route of peerConfig.routes) {
        const routeMatch = btpRoutes.find((r) => r.prefix === route.prefix);
        if (routeMatch) {
          return routeMatch.nextHop;
        }
      }
    }

    return undefined;
  }

  // Wire connector as admin for the discovery tracker (auto-peering on discovery)
  // ConnectorNode.registerPeer() returns Promise<PeerInfo> but ConnectorAdminClient
  // expects Promise<void>, and settlement.preference types differ (string vs union),
  // so we cast and wrap with void returns.
  discoveryTracker.setConnectorAdmin({
    addPeer: async (peerConfig) => {
      const constructorPeerId = resolveConstructorPeerId(
        peerConfig as {
          id: string;
          url: string;
          routes?: { prefix: string }[];
          evmAddress?: string;
        }
      );
      if (constructorPeerId) {
        discoveredToConstructorPeerId.set(peerConfig.id, constructorPeerId);
        console.log(
          `[Discovery] Reusing constructor peerId '${constructorPeerId}' for discovered peer (was '${peerConfig.id}')`
        );
      }
      await connector.registerPeer(
        (constructorPeerId
          ? { ...peerConfig, id: constructorPeerId }
          : peerConfig) as Parameters<typeof connector.registerPeer>[0]
      );
    },
    removePeer: async (peerId) => {
      const resolvedPeerId =
        discoveredToConstructorPeerId.get(peerId) ?? peerId;
      await connector.removePeer(resolvedPeerId);
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
    // Wire external bootstrapService with connector clients.
    // Use wrapped admin client that reuses constructor peer IDs to prevent
    // route/channel mismatch (same resolver pattern as DiscoveryTracker).
    const directIlpClient = createDirectIlpClient(
      node.connector as unknown as Parameters<typeof createDirectIlpClient>[0],
      { toonDecoder: decodeEventFromToon }
    );
    bootstrapService.setIlpClient(directIlpClient);

    const bootstrapAdminClient = createDirectConnectorAdmin({
      registerPeer: async (params) => {
        const constructorPeerId = resolveConstructorPeerId(
          params as {
            id: string;
            url: string;
            routes?: { prefix: string }[];
            evmAddress?: string;
          }
        );
        if (constructorPeerId) {
          discoveredToConstructorPeerId.set(params.id, constructorPeerId);
          console.log(
            `[Bootstrap] Reusing constructor peerId '${constructorPeerId}' for bootstrap peer (was '${params.id}')`
          );
        }
        await connector.registerPeer(
          (constructorPeerId
            ? { ...params, id: constructorPeerId }
            : params) as Parameters<typeof connector.registerPeer>[0]
        );
      },
      removePeer: async (peerId) => {
        const resolvedPeerId =
          discoveredToConstructorPeerId.get(peerId) ?? peerId;
        await connector.removePeer(resolvedPeerId);
      },
    });
    bootstrapService.setConnectorAdmin(bootstrapAdminClient);

    if (node.channelClient) {
      bootstrapService.setChannelClient(node.channelClient);
    }

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

    // Carry the node's route addresses OUT OF BAND in the announcement CONTENT
    // (NOT core's IlpPeerInfo wire types — see issue #22). The genesis seed
    // gives a client only connect info (pubkey/relayUrl/ilpAddress/btpEndpoint);
    // routing is meant to be learned from this announcement at connect time, so
    // a client never needs a hardcoded publish/store route map in config.json.
    const announcementRoutes = resolveAnnouncementRoutes(config.ilpAddress);
    const ownIlpAnnouncement: IlpPeerInfo & {
      routes: { publish: string; store: string };
    } = {
      ...ownIlpInfo,
      routes: announcementRoutes,
    };
    console.log(
      `[Announce] Route hints: publish=${announcementRoutes.publish} store=${announcementRoutes.store}`
    );

    // The kind:10032 announcement carries a NIP-40 `expiration` tag, so when it
    // is published ONCE at bootstrap it goes dark the moment the tag lapses and
    // connecting clients (which skip expired events) fall back to their
    // hardcoded route map (issue #22). Republish on an interval that refreshes
    // at HALF the TTL so a fresh, unexpired event is CONTINUOUSLY available on
    // the local relay for as long as the node is up. Mirrors the
    // publishAttestation interval pattern below (a DIFFERENT, kind:10033 event).
    const ilpInfoRefreshSeconds = parseInt(
      process.env['ILP_INFO_REFRESH_INTERVAL'] || '300',
      10
    );

    const publishOwnIlpInfo = () => {
      try {
        const ilpInfoEvent = buildIlpPeerInfoEvent(
          ownIlpAnnouncement,
          config.secretKey,
          { ttlSeconds: ilpInfoRefreshSeconds * 2 }
        );
        eventStore.store(ilpInfoEvent);
        wsRelay.broadcastEvent(ilpInfoEvent);
        console.log(
          `[Announce] Published own ILP info to local relay (id: ${ilpInfoEvent.id.slice(0, 16)}..., expires in ${ilpInfoRefreshSeconds * 2}s)`
        );
      } catch (error) {
        console.warn('[Announce] Failed to publish ILP info:', error);
      }
    };

    publishOwnIlpInfo();
    setInterval(publishOwnIlpInfo, ilpInfoRefreshSeconds * 1000);

    // Publish kind:10035 service discovery event to local relay.
    // Advertises pricing, supported kinds, and DVM capabilities (e.g., Arweave blob storage).
    try {
      const supportedKinds = [1, ILP_PEER_INFO_KIND, 10035, 10036];
      const capabilities: string[] = ['relay'];

      // If Arweave DVM is enabled, advertise kind:5094 and DVM capability
      if (config.ardriveEnabled) {
        supportedKinds.push(BLOB_STORAGE_REQUEST_KIND);
        capabilities.push('dvm', 'arweave-storage');
      }

      const serviceDiscoveryContent: Record<string, unknown> = {
        serviceType: 'relay',
        ilpAddress: config.ilpAddress,
        pricing: {
          basePricePerByte: Number(config.basePricePerByte),
          currency: 'USDC',
        },
        supportedKinds,
        capabilities,
        chain: config.settlementInfo?.supportedChains?.[0] ?? 'anvil',
        version: '3.0.0',
      };

      // Add DVM skill descriptor when Arweave is enabled
      if (config.ardriveEnabled) {
        serviceDiscoveryContent['skill'] = {
          name: 'arweave-storage',
          version: '1.0',
          kinds: [BLOB_STORAGE_REQUEST_KIND],
          features: ['blob-storage', 'chunked-upload'],
          inputSchema: {},
          pricing: {
            [String(BLOB_STORAGE_REQUEST_KIND)]: String(config.basePricePerByte),
          },
        };
      }

      const serviceDiscoveryEvent = buildServiceDiscoveryEvent(
        serviceDiscoveryContent as unknown as Parameters<typeof buildServiceDiscoveryEvent>[0],
        config.secretKey,
      );
      eventStore.store(serviceDiscoveryEvent);
      console.log('[Bootstrap] Published kind:10035 service discovery to local relay');
    } catch (error) {
      console.warn('[Bootstrap] Failed to publish service discovery:', error);
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

    // Restore constructor BTP routes to ensure they take precedence over
    // any bootstrap/discovery routes that may have overwritten them.
    if (btpRoutes.length > 0) {
      for (const route of btpRoutes) {
        connector.addRoute({ ...route, priority: route.priority ?? 0 });
      }
      console.log(`[BTP] Restored ${btpRoutes.length} constructor route(s) after bootstrap`);
    }

    // Announce own ILP info to bootstrap peers via ILP.
    // This stores our kind:10032 on their relay, enabling them to discover
    // and auto-register us for multi-hop routing.
    for (const result of results) {
      try {
        const announceEvent = buildIlpPeerInfoEvent(
          ownIlpAnnouncement,
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
