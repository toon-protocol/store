/**
 * DVM Node Entrypoint Adapter (Story 21.7 + 21.12)
 *
 * Maps Townhouse orchestrator environment variables to DVM Node config,
 * loads JSON config from DVM_CONFIG_JSON or DVM_CONFIG_PATH,
 * registers the Arweave DVM handler (kind:5094),
 * and invokes createNode() in standalone HTTP mode.
 *
 * Story 21.12 additions:
 *   - Hono BLS health server on blsPort (3400) exposing DvmHealthResponse
 *   - Job-counter shim wrapping handlers (5-minute sliding window)
 *   - KIND_PRICING_<kind>=<value> env-var support
 *
 * This is compiled via esbuild into a single ESM bundle for the Docker
 * runtime stage.
 *
 * Environment variable mapping:
 *   DVM_CONFIG_JSON       -> JSON config (mutually exclusive with DVM_CONFIG_PATH)
 *   DVM_CONFIG_PATH      -> Path to JSON config file
 *   NODE_NOSTR_SECRET_KEY -> config.secretKey (64-char hex)
 *   BLS_PORT             -> config.blsPort (default: 3400)
 *   HANDLER_PORT         -> config.handlerPort (default: 3300)
 *   CONNECTOR_URL        -> config.connectorUrl (standalone connector HTTP URL)
 *   FEE_PER_JOB         -> config.basePricePerByte (per-job pricing)
 *   KIND_PRICING_<kind>  -> config.kindPricing[kind] (per-kind override)
 *   TURBO_TOKEN         -> Arweave upload token for Arweave DVM
 *
 * Key differences from Town/Mill entries:
 * - Uses standalone HTTP mode (connectorUrl + handlerPort) NOT embedded BTP
 * - Registers ONLY kind:5094 Arweave DVM. kind:5250 Dungeon DVM was removed
 *   from this image (operator decision: this DVM is Arweave-only) so the
 *   bundle no longer pulls in pet-dvm / memvid-node / o1js / mina-signer.
 * - Creates ArweaveUploadAdapter from TURBO_TOKEN for blob storage DVM
 */

import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createNode, type ToonNode } from '@toon-protocol/sdk';
import type { DvmHealthResponse } from '@toon-protocol/sdk';
import {
  createArweaveDvmHandler,
  type ArweaveDvmConfig,
  TurboUploadAdapter,
  type ArweaveUploadAdapter,
  ChunkManager,
} from '@toon-protocol/sdk';
import type { NodeConfig } from '@toon-protocol/sdk';
import type { UnsignedEvent } from '@toon-protocol/core';

// --- Job counter shim (5-minute sliding window) ---

interface JobEvent {
  ts: number;
  kind: number;
  status: 'success' | 'error';
}

interface JobCounterSnapshot {
  total: number;
  byKind: { kind: number; count: number }[];
  byStatus: { processing: number; success: number; error: number; partial: number };
}

interface JobCounter {
  wrap<T>(kind: number, handler: (ctx: T) => Promise<unknown>): (ctx: T) => Promise<unknown>;
  snapshot(): JobCounterSnapshot;
}

export function createJobCounter(windowMs: number = 5 * 60 * 1000): JobCounter {
  const events: JobEvent[] = [];
  let processing = 0;

  function evict() {
    const cutoff = Date.now() - windowMs;
    while (events.length > 0 && events[0]!.ts < cutoff) {
      events.shift();
    }
  }

  function wrap<T>(kind: number, handler: (ctx: T) => Promise<unknown>) {
    return async (ctx: T): Promise<unknown> => {
      processing++;
      try {
        const result = await handler(ctx);
        processing = Math.max(0, processing - 1);
        events.push({ ts: Date.now(), kind, status: 'success' });
        evict();
        return result;
      } catch (err) {
        processing = Math.max(0, processing - 1);
        events.push({ ts: Date.now(), kind, status: 'error' });
        evict();
        throw err;
      }
    };
  }

  function snapshot(): JobCounterSnapshot {
    evict();
    const byKindMap = new Map<number, number>();
    let success = 0;
    let error = 0;
    for (const e of events) {
      byKindMap.set(e.kind, (byKindMap.get(e.kind) ?? 0) + 1);
      if (e.status === 'success') success++;
      else error++;
    }
    const byKind = Array.from(byKindMap.entries()).map(([kind, count]) => ({ kind, count }));
    return {
      total: events.length,
      byKind,
      byStatus: { processing, success, error, partial: 0 },
    };
  }

  return { wrap, snapshot };
}

// --- Helper: Create Turbo adapter from token ---
async function createTurboAdapter(
  token: string | undefined
): Promise<ArweaveUploadAdapter> {
  if (!token) {
    // Return a null adapter that throws — caller must check before using
    return {
      upload: async () => {
        throw new Error(
          'TURBO_TOKEN is required for Arweave DVM uploads. Set TURBO_TOKEN env var.'
        );
      },
    };
  }

  // Lazy-import turbo-sdk and create authenticated client from token
  const { TurboFactory } = await import('@ardrive/turbo-sdk/node');
  // Token is a signed JWK (JSON) from operator's Arweave wallet
  // Parse it and use as JWK for Turbo authenticated client
  let jwk: unknown;
  try {
    jwk = JSON.parse(token);
  } catch {
    throw new Error(
      'TURBO_TOKEN must be a valid JSON JWK. Use Arweave wallet private key (JSON).'
    );
  }
  const client = TurboFactory.authenticated({
    privateKey: jwk as Parameters<typeof TurboFactory.authenticated>[0]['privateKey'],
  });
  return new TurboUploadAdapter(client);
}

// --- Raw config shape ---
interface DvmRawConfig {
  secretKey?: string; // hex
  blsPort?: number;
  handlerPort?: number;
  connectorUrl?: string;
  basePricePerByte?: string | number;
  kindPricing?: Record<string, string | number>;
  // Arweave DVM config
  turboToken?: string;
  arweaveTags?: Record<string, string>;
}

// --- Parse and normalize config ---
function parseRawConfig(raw: DvmRawConfig): Partial<NodeConfig> {
  const cfg: Partial<NodeConfig> = {};

  if (raw.secretKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(raw.secretKey)) {
      throw new Error('config.secretKey must be a 64-character hex string (32 bytes)');
    }
    cfg.secretKey = Uint8Array.from(Buffer.from(raw.secretKey, 'hex'));
  }

  if (raw.blsPort !== undefined) {
    cfg.blsPort = raw.blsPort;
  }
  if (raw.handlerPort !== undefined) {
    cfg.handlerPort = raw.handlerPort;
  }
  if (raw.connectorUrl) {
    cfg.connectorUrl = raw.connectorUrl;
  }
  if (raw.basePricePerByte) {
    cfg.basePricePerByte = BigInt(String(raw.basePricePerByte));
  }
  if (raw.kindPricing) {
    cfg.kindPricing = Object.fromEntries(
      Object.entries(raw.kindPricing)
        .filter(([k]) => !isNaN(parseInt(k, 10)))
        .map(([k, v]) => [parseInt(k, 10), BigInt(String(v))])
    );
  }

  return cfg;
}

// --- Load config from env or file ---
function loadDvmConfig(): DvmRawConfig {
  const env = process.env;
  let rawConfig: DvmRawConfig;

  // Priority: DVM_CONFIG_JSON > DVM_CONFIG_PATH > env vars
  if (env['DVM_CONFIG_JSON']) {
    try {
      rawConfig = JSON.parse(env['DVM_CONFIG_JSON']);
    } catch (err) {
      throw new Error(
        `Failed to parse DVM_CONFIG_JSON: ${err instanceof Error ? err.message : err}`
      );
    }
  } else if (env['DVM_CONFIG_PATH']) {
    const configPath = env['DVM_CONFIG_PATH'];
    try {
      const content = readFileSync(configPath, 'utf-8');
      if (!content.trim()) {
        throw new Error('DVM_CONFIG_PATH file is empty');
      }
      rawConfig = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `Failed to read DVM_CONFIG_PATH (${configPath}): ${err instanceof Error ? err.message : err}`
      );
    }
  } else {
    // No JSON config — use env vars directly (minimal config)
    rawConfig = {};
  }

  return rawConfig;
}

// --- Apply env var overlays to config ---
export function applyEnvOverlay(cfg: Partial<NodeConfig>): Partial<NodeConfig> {
  const out = { ...cfg };
  const env = process.env;

  // Secret key (from NODE_NOSTR_SECRET_KEY env var)
  if (env['NODE_NOSTR_SECRET_KEY'] && !out.secretKey) {
    const hex = env['NODE_NOSTR_SECRET_KEY'];
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('NODE_NOSTR_SECRET_KEY must be a 64-char hex string');
    }
    out.secretKey = Uint8Array.from(Buffer.from(hex, 'hex'));
  }

  // BLS port (default 3400)
  if (env['BLS_PORT']) {
    const p = parseInt(env['BLS_PORT'], 10);
    if (!Number.isFinite(p) || p < 0 || p > 65535) {
      throw new Error('BLS_PORT must be 0..65535');
    }
    out.blsPort = p;
  } else if (out.blsPort === undefined) {
    out.blsPort = 3400;
  }

  // Handler port (default 3300) — standalone HTTP server port
  if (env['HANDLER_PORT']) {
    const p = parseInt(env['HANDLER_PORT'], 10);
    if (!Number.isFinite(p) || p < 0 || p > 65535) {
      throw new Error('HANDLER_PORT must be 0..65535');
    }
    out.handlerPort = p;
  } else if (out.handlerPort === undefined) {
    out.handlerPort = 3300;
  }

  // Validate ports don't conflict
  if (out.handlerPort === out.blsPort) {
    throw new Error('HANDLER_PORT and BLS_PORT must differ');
  }

  // Connector URL (standalone mode — REQUIRED)
  // CONNECTOR_URL is injected by orchestrator: ws://townhouse-connector:3000
  // For HTTP mode, we use the admin URL (8081 or equivalent)
  if (env['CONNECTOR_URL']) {
    // Convert ws:// to http:// or wss:// to https:// for REST API
    const wsUrl = env['CONNECTOR_URL'];
    out.connectorUrl = wsUrl.replace(/^ws(s)?:/, (match, s) => s ? 'https:' : 'http:').replace(/\/ws(\?.*)?$/, (match, query) => query || '');
  } else if (!out.connectorUrl) {
    throw new Error('CONNECTOR_URL must be provided for standalone DVM mode');
  }

  // Base price per byte (default 10n = $0.00001/byte). Applies to the
  // Arweave DVM (kind:5094) as per-byte pricing.
  if (env['FEE_PER_JOB']) {
    out.basePricePerByte = BigInt(env['FEE_PER_JOB']);
  } else if (out.basePricePerByte === undefined) {
    out.basePricePerByte = 10n;
  }

  // KIND_PRICING_<kind>=<value> — per-kind overrides take precedence over FEE_PER_JOB
  // Scan all env keys matching /^KIND_PRICING_(\d+)$/.
  const kindPricingPattern = /^KIND_PRICING_(\d+)$/;
  for (const [key, value] of Object.entries(env)) {
    const match = kindPricingPattern.exec(key);
    if (!match || value === undefined) continue;
    const kind = parseInt(match[1]!, 10);
    if (!Number.isFinite(kind)) continue;
    try {
      const price = BigInt(value);
      out.kindPricing = { ...out.kindPricing, [kind]: price };
    } catch {
      // Surface bad config: log a warning so operators can see why the env
      // var didn't take effect. Do not throw — keeps startup resilient.
      console.warn(
        `[DVM Entrypoint] Ignoring ${key}: value ${JSON.stringify(value)} is not a valid bigint`
      );
    }
  }

  return out;
}

// --- Publish event callback (no-op for standalone DVM) ---
async function noopPublish(event: UnsignedEvent): Promise<void> {
  // In standalone mode, there's no relay WebSocket connection.
  // Events are either:
  // - Not published (Arweave DVM returns txId directly)
  // - Published via separate relay connection (future enhancement)
  console.log(
    `[DVM] Would publish event kind:${event.kind} id:${event.id?.slice(0, 12)}...`
  );
}

// --- Main entrypoint ---
async function main(): Promise<ToonNode> {
  console.log('[DVM Entrypoint] Starting DVM node...');

  // Load JSON config from env or file, then overlay env vars
  const rawConfig = loadDvmConfig();
  const jsonConfig = parseRawConfig(rawConfig);
  const config = applyEnvOverlay(jsonConfig);

  // Validate required fields
  if (!config.secretKey) {
    throw new Error('NODE_NOSTR_SECRET_KEY is required');
  }
  if (!config.connectorUrl) {
    throw new Error('CONNECTOR_URL is required for standalone DVM mode');
  }

  // Build Arweave DVM components
  // TURBO_TOKEN can be in JSON config or env var
  const turboToken = rawConfig.turboToken || process.env['TURBO_TOKEN'];
  const turboAdapter = turboToken ? await createTurboAdapter(turboToken) : null;
  const chunkManager = new ChunkManager(); // in-memory, v1

  const arweaveConfig: ArweaveDvmConfig = {
    turboAdapter,
    chunkManager,
    arweaveTags: rawConfig.arweaveTags,
  };

  // Create node in standalone mode (HTTP handler, NOT embedded connector)
  console.log('[DVM Entrypoint] Creating node in standalone HTTP mode...');
  console.log(`  connectorUrl: ${config.connectorUrl}`);
  console.log(`  handlerPort: ${config.handlerPort}`);
  console.log(`  blsPort: ${config.blsPort}`);

  const node = await createNode({
    secretKey: config.secretKey,
    connectorUrl: config.connectorUrl,
    handlerPort: config.handlerPort,
    blsPort: config.blsPort,
    basePricePerByte: config.basePricePerByte,
    kindPricing: config.kindPricing,
    devMode: process.env['NODE_ENV'] !== 'production',
  });

  // Job counter shim — wraps each handler to track byKind + byStatus counters
  const counter = createJobCounter();

  // Register DVM handlers (wrapped with counter shim)
  // kind:5094 — Arweave blob storage DVM
  console.log('[DVM Entrypoint] Registering Arweave DVM handler (kind:5094)...');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node.on(5094, counter.wrap(5094, createArweaveDvmHandler(arweaveConfig)) as any);

  // Start the node
  console.log('[DVM Entrypoint] Starting DVM node...');
  await node.start();

  // BLS health server on blsPort (3400 default) — started after node.start()
  const pubkey = node.identity?.pubkey;
  const safePubkey = typeof pubkey === 'string' ? pubkey : 'unknown';
  const startedAt = Date.now();
  const blsPort = config.blsPort ?? 3400;

  const blsApp = new Hono();
  blsApp.get('/health', (c) => {
    const health: DvmHealthResponse = {
      status: 'ok',
      version: '1.0.0',
      nodePubkey: safePubkey,
      uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      handlerKinds: [5094],
      kindPricing: Object.fromEntries(
        Object.entries(config.kindPricing ?? {}).map(([k, v]) => [k, String(v)])
      ),
      basePricePerByte: String(config.basePricePerByte ?? 10n),
      jobsRecent: counter.snapshot(),
    };
    return c.json(health);
  });

  const blsServer = serve({ fetch: blsApp.fetch, port: blsPort }) as unknown as {
    close: (cb?: (err?: Error) => void) => void;
  };
  console.log(`[DVM Entrypoint] BLS health server on port ${blsPort}`);

  // Log startup banner
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                     DVM Ready                          ║
╠═══════════════════════════════════════════════════════════╣
║ Pubkey:        ${safePubkey.slice(0, 32)}... ║
║ Handler Port:   ${config.handlerPort} (HTTP ILP)                          ║
║ BLS Port:      ${blsPort} (health endpoint)                       ║
║ Handler Kinds: 5094 (Arweave only)                    ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // Clean up sensitive env vars after extraction
  delete process.env['NODE_NOSTR_SECRET_KEY'];

  // Graceful shutdown handlers
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[DVM Entrypoint] Received ${signal}, shutting down...`);
    try {
      // serve() returns a Node http.Server whose close() takes a callback.
      // Wrap to actually wait for sockets to drain before stopping the node.
      await new Promise<void>((resolve, reject) => {
        blsServer.close((err) => (err ? reject(err) : resolve()));
      });
      await node.stop();
      console.log('[DVM Entrypoint] DVM stopped gracefully');
    } catch (err) {
      console.error('[DVM Entrypoint] Error during shutdown:', err);
    } finally {
      process.exit(0);
    }
  };

  // Remove any existing handlers to prevent duplicates
  process.off('SIGTERM', shutdown);
  process.off('SIGINT', shutdown);
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return node;
}

// Gated so importing this module from a test (Vitest sets VITEST=true) does
// not spin up an actual DVM node — tests drive exported functions directly.
if (!process.env['VITEST']) {
  main().catch((err) => {
    console.error(`[DVM Entrypoint] [Fatal] ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
}