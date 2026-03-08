/**
 * SDK Reference Implementation -- Crosstown Container Entrypoint (Town)
 *
 * This file is the canonical reference implementation for building an ILP-gated
 * Nostr relay using @crosstown/sdk and @crosstown/town. Developers should study
 * this file to understand how SDK components compose into a production service.
 *
 * ## SDK Pattern: Identity -> Pipeline Components -> Handler Registration -> Lifecycle
 *
 * The construction follows a deliberate order:
 * 1. **Identity** -- Derive a unified secp256k1 identity (Nostr pubkey + EVM address)
 *    from a single secret key using `fromSecretKey()`.
 * 2. **Pipeline components** -- Create verification and pricing stages that form
 *    the inbound packet processing pipeline.
 * 3. **Handler registration** -- Wire domain-specific handlers (event storage)
 *    into a `HandlerRegistry` that dispatches by Nostr event kind.
 * 4. **Lifecycle** -- Start services (HTTP, WebSocket, bootstrap, discovery) and
 *    wire graceful shutdown to clean up subscriptions and connections.
 *
 * ## Why Approach A (Individual Components) Instead of createNode()
 *
 * `createNode()` assumes an embedded connector (it creates and manages the connector
 * lifecycle internally). In Docker deployment, the connector runs as a separate
 * container, so we use individual SDK components (`fromSecretKey`,
 * `createVerificationPipeline`, `createPricingValidator`, `HandlerRegistry`,
 * `createHandlerContext`) wired to an external BLS HTTP endpoint. This gives full
 * control over the connector admin client and channel client configuration.
 *
 * ## SDK Features Exercised
 *
 * - **Identity:** `fromSecretKey()` -- unified secp256k1 identity (Nostr + EVM)
 * - **Verification:** `createVerificationPipeline()` -- Schnorr signature verification
 * - **Pricing:** `createPricingValidator()` -- per-byte pricing, self-write bypass
 * - **Handlers:** `HandlerRegistry` -- kind-based dispatch (.onDefault, .on)
 * - **Context:** `createHandlerContext()` -- raw TOON passthrough, lazy decode
 * - **Town handlers:** `createEventStorageHandler()`
 * - **Bootstrap:** `BootstrapService`, `RelayMonitor`, `SocialPeerDiscovery`
 * - **Channels:** Settlement negotiation and payment channel lifecycle
 *
 * Pipeline: size check -> shallow TOON parse -> Schnorr verify -> pricing validate -> handler dispatch
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
} from '@crosstown/town';
import {
  BootstrapService,
  RelayMonitor,
  createAgentRuntimeClient,
  SocialPeerDiscovery,
  buildIlpPeerInfoEvent,
} from '@crosstown/core';
import type {
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
  waitForAgentRuntime,
} from './shared.js';

// ---------- SDK Pipeline Constants ----------
const MAX_PAYLOAD_BASE64_LENGTH = 1_048_576;

// ---------- SDK Pipeline Handler ----------
function createPipelineHandler(
  eventStore: EventStore,
  config: ReturnType<typeof parseConfig>
) {
  // --- Identity derivation ---
  // fromSecretKey() produces a NodeIdentity with both a Nostr pubkey (x-only
  // Schnorr/BIP-340) and an EVM address (Keccak-256) from a single secp256k1
  // secret key. This unified identity lets the node sign Nostr events and
  // participate in on-chain payment channel settlement with the same key.
  const identity = fromSecretKey(config.secretKey);

  // --- Verification pipeline ---
  // Schnorr signature verification ensures every inbound event was signed by
  // the claimed pubkey. This runs AFTER shallow TOON parse but BEFORE decode,
  // because verifying the serialized bytes is the only safe order -- decoding
  // first would trust unverified data. devMode: false enables full verification
  // (devMode: true would skip verification entirely for local testing).
  const verifier = createVerificationPipeline({ devMode: false });

  // --- Pricing validator ---
  // Per-byte pricing: requiredAmount = rawBytes.length * basePricePerByte.
  // ownPubkey enables the self-write bypass -- events from this node's own
  // pubkey are free, which is essential for publishing kind:10032 peer info
  // without paying yourself.
  const pricer = createPricingValidator({
    basePricePerByte: config.basePricePerByte,
    ownPubkey: identity.pubkey,
  });

  // --- Handler registry ---
  // HandlerRegistry dispatches to handlers by Nostr event kind. .onDefault()
  // registers the fallback handler for all event kinds not explicitly registered.
  const registry = new HandlerRegistry();
  registry.onDefault(createEventStorageHandler({ eventStore }));

  // --- TOON decoder for HandlerContext ---
  // The handler context receives raw TOON data as a base64 string (TOON
  // passthrough). Handlers that need structured NostrEvent data call
  // ctx.decode(), which uses this decoder. The lazy decode pattern means
  // decode only happens when a handler explicitly requests it -- handlers
  // that only need routing metadata (kind, pubkey) can skip the decode cost.
  const toonDecoder = (toon: string) => {
    const bytes = Buffer.from(toon, 'base64');
    return decodeEventFromToon(bytes);
  };

  // --- 5-stage pipeline ---
  // The pipeline processes each inbound ILP packet through 5 sequential stages:
  // size check -> shallow parse -> verify -> price -> dispatch. Each stage can
  // reject the packet early, avoiding unnecessary work in later stages.
  return async (
    request: HandlePacketRequest
  ): Promise<HandlePacketAcceptResponse | HandlePacketRejectResponse> => {
    // Stage 1: Size check -- reject before allocating a Buffer (DoS mitigation)
    if (request.data.length > MAX_PAYLOAD_BASE64_LENGTH) {
      return { accept: false, code: 'F08', message: 'Payload too large' };
    }

    // Stage 2: Shallow TOON parse -- extract routing metadata without full decode
    const toonBytes = Buffer.from(request.data, 'base64');
    let meta;
    try {
      meta = shallowParseToon(toonBytes);
    } catch {
      return { accept: false, code: 'F06', message: 'Invalid TOON payload' };
    }

    // Stage 3: Schnorr signature verification on serialized bytes
    const verifyResult = await verifier.verify(meta, request.data);
    if (!verifyResult.verified) {
      if (verifyResult.rejection) {
        return verifyResult.rejection;
      }
      return { accept: false, code: 'F06', message: 'Verification failed' };
    }

    // Stage 4: Pricing validation (with self-write bypass for own pubkey)
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

    // Stage 5: Build HandlerContext (TOON passthrough + lazy decode) and dispatch
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

  // --- EventStore initialization ---
  // SqliteEventStore persists events in TOON-native format -- events are stored
  // as TOON bytes, not JSON. This is the relay's source of truth for all events
  // and also serves NIP-01 REQ queries via the WebSocket relay.
  const dataDir = process.env['DATA_DIR'] || '/data';
  const dbPath = `${dataDir}/events.db`;
  const eventStore = new SqliteEventStore(dbPath);
  console.log(`[Setup] Initialized event store at ${dbPath}`);

  const adminClient = createConnectorAdminClient(config.connectorAdminUrl);

  // Create SDK pipeline handler
  const handlePacket = createPipelineHandler(eventStore, config);
  console.log(
    '[Setup] SDK pipeline wired: size -> parse -> verify -> price -> dispatch'
  );

  // Parse bootstrap peers once (reused by BootstrapService and publishOwnIlpInfo)
  const knownPeers = parseBootstrapPeers(config);

  // --- Bootstrap lifecycle management ---
  // BootstrapService orchestrates the bootstrap lifecycle: discovering known
  // peers, registering with the connector, opening payment channels, and
  // transitioning through phases (discovering -> registering -> announcing -> ready).
  // RelayMonitor watches for new kind:10032 events on peer relays to discover
  // peers that join after initial bootstrap. SocialPeerDiscovery finds peers
  // via social graph on public Nostr relays.
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
      if (
        body.amount === undefined ||
        body.amount === null ||
        !body.destination ||
        !body.data
      ) {
        return c.json(
          { accept: false, code: 'F00', message: 'Missing required fields' },
          400
        );
      }
      const result = await handlePacket(body);
      return c.json(result, result.accept ? 200 : 400);
    } catch (error) {
      // Log the full error server-side for debugging, but return a generic
      // message to the caller to avoid leaking internal details (CWE-209).
      console.error('[handle-packet] Unexpected error:', error);
      return c.json(
        {
          accept: false,
          code: 'T00',
          message: 'Internal server error',
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

    // --- Self-write bypass ---
    // Publishing our own kind:10032 peer info event to the local relay
    // and to the genesis relay via ILP. The pricing validator's self-write
    // bypass ensures this node's own events are stored without payment --
    // without this, the node would need to pay itself to advertise.
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

  // --- Graceful shutdown ---
  // Unsubscribe relay monitor and social discovery to stop WebSocket
  // connections, then stop the Nostr relay and BLS HTTP server. This ensures
  // no dangling connections or subscriptions remain after the process exits.
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
