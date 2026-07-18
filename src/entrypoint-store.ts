/**
 * Store entrypoint — NIP-90 kind:5094 Arweave blob storage, deployed BEHIND the
 * connector (the connector is the front-of-app payment proxy).
 *
 * Loads config from STORE_CONFIG_JSON / STORE_CONFIG_PATH (or env vars), builds
 * the Arweave upload adapter, and serves the payment-oblivious `POST /store`
 * backend (see ./store-backend) that the connector reverse-proxies to via
 * RouteTermination. The store contains NO ILP / connector-dialing / settlement
 * logic — payment is enforced upstream by the connector.
 *
 * This is compiled via esbuild into a single ESM bundle for the Docker runtime.
 *
 * Environment variable mapping:
 *   STORE_CONFIG_JSON     -> JSON config (mutually exclusive with STORE_CONFIG_PATH)
 *   STORE_CONFIG_PATH     -> Path to JSON config file
 *   NODE_NOSTR_SECRET_KEY -> config.secretKey (64-char hex)
 *   BLS_PORT              -> config.blsPort (default: 3400; health endpoint)
 *   HANDLER_PORT          -> config.handlerPort (default: 3300; POST /store backend)
 *   FEE_PER_JOB           -> config.basePricePerByte (informational; the connector
 *                            enforces the flat route price)
 *   KIND_PRICING_<kind>   -> config.kindPricing[kind] (per-kind override)
 *   STORE_ARWEAVE_JWK_B64 -> Preferred: base64(JSON) of an RSA JWK Arweave wallet.
 *                            Treated as secret — never logged.
 *   TURBO_TOKEN           -> Legacy fallback: raw JSON JWK for Arweave uploads.
 *   ARNS_DVM_SOLANA_SECRET_KEY -> OPTIONAL: 128-char hex (64-byte Ed25519
 *                            keypair) of the DVM's funded Solana wallet.
 *                            When set, the kind:5095 ArNS brokered-buy job
 *                            ("buyfor" — see ./arns-buy-handler) is enabled.
 *                            Treated as secret — never logged.
 *   ARNS_NETWORK          -> devnet (default) | mainnet — which ar.io registry
 *                            the kind:5095 buys target. Mainnet is explicit
 *                            opt-in only.
 *
 * Registers kind:5094 Arweave blob storage, plus kind:5095 ArNS buy when
 * ARNS_DVM_SOLANA_SECRET_KEY is configured. kind:5250 Dungeon DVM was
 * removed from this image (Arweave-only) so the bundle no longer pulls in
 * pet-dvm / memvid-node / o1js / mina-signer.
 */

import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getPublicKey } from 'nostr-tools/pure';
import type { DvmHealthResponse } from '@toon-protocol/sdk';
import {
  createArweaveDvmHandler,
  type ArweaveDvmConfig,
  TurboUploadAdapter,
  type ArweaveUploadAdapter,
  ChunkManager,
} from '@toon-protocol/sdk';
import type { NodeConfig } from '@toon-protocol/sdk';
import { startStoreBackend, type StoreBackend, type StoreHandler } from './store-backend.js';
import {
  ARNS_BUY_KIND,
  createArnsBuyHandler,
  type ArnsNetwork,
} from './arns-buy-handler.js';

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

// --- Helper: bytes formatter (inlined to keep the Docker bundle self-contained) ---
// base-1000 SI units, rounds DOWN.
const WINC_PER_BYTE_FALLBACK = 610_000n; // ~ARIO mainnet rate floor; sufficient for a boot-time log line
function formatWincAsBytes(winc: bigint): string {
  if (winc <= 0n) return '~0 B';
  const bytes = winc / WINC_PER_BYTE_FALLBACK;
  if (bytes < 1_000n) return `~${bytes.toString()} B`;
  if (bytes < 1_000_000n) return `~${(bytes / 1_000n).toString()} KB`;
  if (bytes < 1_000_000_000n) return `~${(bytes / 1_000_000n).toString()} MB`;
  if (bytes < 1_000_000_000_000n) return `~${(bytes / 1_000_000_000n).toString()} GB`;
  return `~${(bytes / 1_000_000_000_000n).toString()} TB`;
}

// --- Helper: derive the Arweave address (n field of the JWK) without leaking the JWK ---
// Arweave address = base64url(SHA-256(modulus n bytes)). We import lazily so the
// (still-too-rare) bad-JWK path also surfaces a clean error.
async function arweaveAddressFromJwk(jwk: { n?: string }): Promise<string | undefined> {
  if (!jwk?.n || typeof jwk.n !== 'string') return undefined;
  try {
    const { createHash } = await import('node:crypto');
    // The Arweave JWK `n` field is base64url-encoded modulus bytes.
    const modulusBytes = Buffer.from(jwk.n, 'base64url');
    return createHash('sha256').update(modulusBytes).digest('base64url');
  } catch {
    return undefined;
  }
}

interface CreateTurboAdapterResult {
  adapter: ArweaveUploadAdapter;
  /** Source of the credentials, for boot-log diagnostics. */
  source: 'arweave-jwk-b64' | 'turbo-token-legacy' | 'unauthenticated-free-tier';
  /** Arweave address of the upload-signing key (only set for authenticated paths). */
  arweaveAddress?: string;
  /** The constructed Turbo client (always set — every path builds one), for balance probing. */
  client?: unknown;
}

// --- Helper: Create Turbo adapter from env (preferred AR JWK path; legacy TURBO_TOKEN fallback) ---
export async function createTurboAdapter(
  arweaveJwkB64: string | undefined,
  legacyToken: string | undefined
): Promise<CreateTurboAdapterResult> {
  // @ts-ignore — @ardrive/turbo-sdk is a transitive peer dep; under pnpm's strict
  // node_modules layout it is not hoisted, so its types are not resolvable here.
  // Use @ts-ignore (not @ts-expect-error) so this stays silent whether or not the
  // package happens to be hoisted in a given install layout.
  const importTurbo = () => import('@ardrive/turbo-sdk/node');

  // Treat an empty OR whitespace-only env var as ABSENT, not "present but
  // invalid" (#146). The deployed dvm container sets `TURBO_TOKEN=""` (len 0)
  // and has no STORE_ARWEAVE_JWK_B64; a bare `if (legacyToken)` already skips ""
  // (falsy), but a stray-whitespace value (e.g. a trailing newline from a
  // here-doc env file) would otherwise be truthy and drive us into the JWK
  // JSON.parse path → a hard throw instead of the free-tier fallback. Normalize
  // both inputs up front so "no credential" reliably resolves to the
  // unauthenticated ≤100 KB free tier.
  const jwkB64 = arweaveJwkB64?.trim() || undefined;
  const token = legacyToken?.trim() || undefined;

  // ── Preferred: STORE_ARWEAVE_JWK_B64 (piped by the host orchestrator) ─────
  if (jwkB64) {
    let jwkJson: string;
    try {
      jwkJson = Buffer.from(jwkB64, 'base64').toString('utf-8');
    } catch (err) {
      throw new Error(
        `STORE_ARWEAVE_JWK_B64 is not valid base64: ${err instanceof Error ? err.message : err}`
      );
    }
    let jwk: { kty?: string; n?: string; d?: string };
    try {
      jwk = JSON.parse(jwkJson);
    } catch (err) {
      throw new Error(
        `STORE_ARWEAVE_JWK_B64 does not decode to valid JSON: ${err instanceof Error ? err.message : err}`
      );
    }
    if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'RSA' || !jwk.n || !jwk.d) {
      throw new Error(
        'STORE_ARWEAVE_JWK_B64 is missing required RSA JWK fields (kty=RSA, n, d).'
      );
    }
    const { TurboFactory, ArweaveSigner } = await importTurbo();
    const signer = new ArweaveSigner(
      jwk as unknown as ConstructorParameters<typeof ArweaveSigner>[0]
    );
    const client = TurboFactory.authenticated({
      signer,
      token: 'arweave',
    });
    const arweaveAddress = await arweaveAddressFromJwk(jwk);
    return {
      adapter: new TurboUploadAdapter(client),
      source: 'arweave-jwk-b64',
      arweaveAddress,
      client,
    };
  }

  // ── Legacy: TURBO_TOKEN (raw JWK JSON) ──────────────────────────────────
  if (token) {
    let jwk: { kty?: string; n?: string; d?: string };
    try {
      jwk = JSON.parse(token);
    } catch {
      throw new Error(
        'TURBO_TOKEN must be a valid JSON JWK. Use Arweave wallet private key (JSON).'
      );
    }
    const { TurboFactory } = await importTurbo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = TurboFactory.authenticated({ privateKey: jwk as any });
    const arweaveAddress = await arweaveAddressFromJwk(jwk);
    return {
      adapter: new TurboUploadAdapter(client),
      source: 'turbo-token-legacy',
      arweaveAddress,
      client,
    };
  }

  // ── Ephemeral JWK free tier (≤100 KB uploads, no wallet required) ─────────
  // TurboFactory.authenticated({privateKey: ephemeralJwk}) with a zero-balance
  // account gives Turbo upload access without a deposit. The JWK is ephemeral —
  // it rotates on every DVM restart and cannot be funded.
  const { TurboFactory } = await importTurbo();
  const { default: Arweave } = await import('arweave');
  const arweave = Arweave.init({});
  const ephemeralJwk = await arweave.crypto.generateJWK();
  const client = TurboFactory.authenticated({ privateKey: ephemeralJwk });
  return {
    adapter: new TurboUploadAdapter(client),
    source: 'unauthenticated-free-tier',
    client,
  };
}

// --- store config extends NodeConfig with store-managed fields not in the SDK ---
type StoreConfig = Partial<NodeConfig> & { blsPort?: number };

// --- Raw config shape ---
interface StoreRawConfig {
  secretKey?: string; // hex
  blsPort?: number;
  handlerPort?: number;
  basePricePerByte?: string | number;
  kindPricing?: Record<string, string | number>;
  // Arweave upload config
  turboToken?: string;
  arweaveTags?: Record<string, string>;
}

// --- Parse and normalize config ---
function parseRawConfig(raw: StoreRawConfig): StoreConfig {
  const cfg: StoreConfig = {};

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
function loadStoreConfig(): StoreRawConfig {
  const env = process.env;
  let rawConfig: StoreRawConfig;

  // Priority: STORE_CONFIG_JSON > STORE_CONFIG_PATH > env vars
  if (env['STORE_CONFIG_JSON']) {
    try {
      rawConfig = JSON.parse(env['STORE_CONFIG_JSON']);
    } catch (err) {
      throw new Error(
        `Failed to parse STORE_CONFIG_JSON: ${err instanceof Error ? err.message : err}`
      );
    }
  } else if (env['STORE_CONFIG_PATH']) {
    const configPath = env['STORE_CONFIG_PATH'];
    try {
      const content = readFileSync(configPath, 'utf-8');
      if (!content.trim()) {
        throw new Error('STORE_CONFIG_PATH file is empty');
      }
      rawConfig = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `Failed to read STORE_CONFIG_PATH (${configPath}): ${err instanceof Error ? err.message : err}`
      );
    }
  } else {
    // No JSON config — use env vars directly (minimal config)
    rawConfig = {};
  }

  return rawConfig;
}

// --- Apply env var overlays to config ---
export function applyEnvOverlay(cfg: StoreConfig): StoreConfig {
  const out: StoreConfig = { ...cfg };
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

  // Base price per byte (default 10n). Informational only: the connector is the
  // front payment proxy and enforces the FLAT route price; this is surfaced on
  // the BLS /health endpoint for operators.
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
        `[store] Ignoring ${key}: value ${JSON.stringify(value)} is not a valid bigint`
      );
    }
  }

  return out;
}

// --- kind:5095 ArNS buy — env resolution (exported for tests) ---

/** Parsed kind:5095 configuration (undefined = job disabled). */
export interface ArnsBuyEnvConfig {
  network: ArnsNetwork;
  solanaSecretKey: Uint8Array;
}

/**
 * Resolve the OPTIONAL kind:5095 ArNS-buy config from the environment.
 * Absent/empty `ARNS_DVM_SOLANA_SECRET_KEY` disables the job (returns
 * undefined); a malformed value throws (misconfiguration must not boot a
 * silently-crippled DVM). `ARNS_NETWORK` defaults to DEVNET — mainnet is an
 * explicit opt-in.
 */
export function resolveArnsBuyEnv(
  env: NodeJS.ProcessEnv
): ArnsBuyEnvConfig | undefined {
  const hex = env['ARNS_DVM_SOLANA_SECRET_KEY']?.trim();
  if (!hex) return undefined;
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) {
    throw new Error(
      'ARNS_DVM_SOLANA_SECRET_KEY must be a 128-char hex string ' +
        '(64-byte Ed25519 keypair: secretKey ‖ publicKey)'
    );
  }
  const networkRaw = env['ARNS_NETWORK']?.trim() || 'devnet';
  if (networkRaw !== 'devnet' && networkRaw !== 'mainnet') {
    throw new Error(
      `ARNS_NETWORK must be 'devnet' or 'mainnet', got ${JSON.stringify(networkRaw)}`
    );
  }
  return {
    network: networkRaw as ArnsNetwork,
    solanaSecretKey: Uint8Array.from(Buffer.from(hex, 'hex')),
  };
}

function buildNoCreditsMessage(address: string | undefined): string {
  const addr = address ?? 'unknown';
  return (
    `Arweave wallet ${addr} has zero credits. Uploads will fail until credits are added. ` +
    `Fund at https://turbo.ardrive.io/ (arweave address: ${addr})`
  );
}

// --- Main entrypoint ---
async function main(): Promise<void> {
  console.log('[store] Starting store node...');

  // Load JSON config from env or file, then overlay env vars
  const rawConfig = loadStoreConfig();
  const jsonConfig = parseRawConfig(rawConfig);
  const config = applyEnvOverlay(jsonConfig);

  // Validate required fields
  if (!config.secretKey) {
    throw new Error('NODE_NOSTR_SECRET_KEY is required');
  }

  // Build the Arweave upload adapter.
  //
  // Resolution order:
  //   1. STORE_ARWEAVE_JWK_B64 (preferred — base64(JSON) of a funded RSA JWK)
  //   2. TURBO_TOKEN (legacy raw-JWK JSON env var)
  //   3. Neither (or empty/whitespace) → unauthenticated ephemeral-JWK FREE
  //      TIER (≤100 KB uploads, no wallet/deposit). An empty `TURBO_TOKEN=""`
  //      must fall back to free tier, NOT reject kind:5094 (#146).
  //
  // The JWK env var is treated as secret material — do NOT log its value.
  const arweaveJwkB64 = process.env['STORE_ARWEAVE_JWK_B64'];
  const legacyTurboToken = rawConfig.turboToken || process.env['TURBO_TOKEN'];
  const turboResult = await createTurboAdapter(arweaveJwkB64, legacyTurboToken);

  const sourceLabel =
    turboResult.source === 'arweave-jwk-b64'
      ? 'STORE_ARWEAVE_JWK_B64 (wallet-derived)'
      : turboResult.source === 'turbo-token-legacy'
        ? 'TURBO_TOKEN (legacy)'
        : 'unauthenticated (free tier, ≤100KB)';
  console.log(`[store] Arweave credit source: ${sourceLabel}`);
  if (turboResult.source === 'unauthenticated-free-tier') {
    console.warn(
      '[store] WARNING: No Arweave credentials — using ephemeral JWK for free-tier uploads (≤100KB).' +
      ' Set STORE_ARWEAVE_JWK_B64 with a funded wallet to lift the size limit.' +
      ' Do NOT fund the ephemeral address — it rotates on every restart.'
    );
  }
  if (turboResult.arweaveAddress) {
    console.log(`[store] Arweave address: ${turboResult.arweaveAddress}`);
  }

  // Best-effort boot-time credit balance probe (warning-only — do not refuse
  // to start; operators may want the store running while they fund).
  if (turboResult.client && typeof turboResult.client === 'object') {
    try {
      const probe = turboResult.client as { getBalance?: () => Promise<{ winc: string | bigint }> };
      if (typeof probe.getBalance === 'function') {
        const rawBalance = await probe.getBalance();
        const wincStr = typeof rawBalance?.winc === 'bigint'
          ? rawBalance.winc.toString()
          : String(rawBalance?.winc ?? '0');
        let wincBig: bigint;
        try {
          wincBig = BigInt(wincStr);
        } catch {
          wincBig = 0n;
        }
        console.log(
          `[store] Arweave credit balance: ${wincStr} winc (${formatWincAsBytes(wincBig)} upload capacity)`
        );
        if (wincBig === 0n && turboResult.source === 'arweave-jwk-b64') {
          console.warn(`[store] ${buildNoCreditsMessage(turboResult.arweaveAddress)}`);
        }
      }
    } catch (err) {
      // Probe failure must not block boot — log and continue.
      console.warn(
        `[store] Could not probe Arweave credit balance: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  const chunkManager = new ChunkManager(); // in-memory, v1

  const arweaveConfig: ArweaveDvmConfig = {
    turboAdapter: turboResult.adapter,
    chunkManager,
    arweaveTags: rawConfig.arweaveTags,
  };

  const devMode = process.env['NODE_ENV'] !== 'production';

  // Job counter shim — wraps the handler to track byKind + byStatus counters
  // (surfaced by the BLS /health endpoint).
  const counter = createJobCounter();
  const arweaveHandler = counter.wrap(5094, createArweaveDvmHandler(arweaveConfig));

  // kind:5095 ArNS brokered buy ("buyfor") — enabled only when the DVM has a
  // funded Solana payer wallet configured. Defaults to DEVNET.
  const arnsBuyEnv = resolveArnsBuyEnv(process.env);
  const extraHandlers: Record<number, StoreHandler> = {};
  if (arnsBuyEnv) {
    extraHandlers[ARNS_BUY_KIND] = counter.wrap(
      ARNS_BUY_KIND,
      createArnsBuyHandler({
        network: arnsBuyEnv.network,
        solanaSecretKey: arnsBuyEnv.solanaSecretKey,
      })
    ) as unknown as StoreHandler;
    console.log(
      `[store] kind:${ARNS_BUY_KIND} ArNS buy enabled (network: ${arnsBuyEnv.network})`
    );
  }
  const handlerKinds = [5094, ...(arnsBuyEnv ? [ARNS_BUY_KIND] : [])];

  // The connector is the front-of-app payment proxy: it terminates payment and
  // reverse-proxies a plain HTTP request to POST /store (RouteTermination). This
  // process contains NO ILP/BTP/connector-dialing logic.
  console.log('[store] Starting payment-oblivious POST /store backend (connector is the front payment proxy)...');
  console.log(`  handlerPort: ${config.handlerPort} (POST /store)`);
  console.log(`  blsPort: ${config.blsPort}`);
  const pubkey = getPublicKey(config.secretKey);
  const storeBackend: StoreBackend = startStoreBackend({
    handle: arweaveHandler as unknown as StoreHandler,
    ...(arnsBuyEnv ? { handlers: extraHandlers } : {}),
    handlerPort: config.handlerPort ?? 3300,
    devMode,
  });

  // BLS health server on blsPort (3400 default) — started after the backend.
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
      handlerKinds,
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
  console.log(`[store] BLS health server on port ${blsPort}`);

  // Log startup banner
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                     store ready                        ║
╠═══════════════════════════════════════════════════════════╣
║ Pubkey:        ${safePubkey.slice(0, 32)}... ║
║ Handler Port:   ${config.handlerPort} (POST /store)                       ║
║ BLS Port:      ${blsPort} (health endpoint)                       ║
║ Handler Kinds: ${handlerKinds.join(', ')}                    ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // Clean up sensitive env vars after extraction
  delete process.env['NODE_NOSTR_SECRET_KEY'];
  delete process.env['ARNS_DVM_SOLANA_SECRET_KEY'];

  // Graceful shutdown handlers
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[store] Received ${signal}, shutting down...`);
    try {
      // serve() returns a Node http.Server whose close() takes a callback.
      // Wait for sockets to drain on both servers before exiting.
      await new Promise<void>((resolve, reject) => {
        blsServer.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        storeBackend.close((err) => (err ? reject(err) : resolve()));
      });
      console.log('[store] stopped gracefully');
    } catch (err) {
      console.error('[store] Error during shutdown:', err);
    } finally {
      process.exit(0);
    }
  };

  // Remove any existing handlers to prevent duplicates
  process.off('SIGTERM', shutdown);
  process.off('SIGINT', shutdown);
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Gated so importing this module from a test (Vitest sets VITEST=true) does
// not spin up an actual store node — tests drive exported functions directly.
if (!process.env['VITEST']) {
  main().catch((err) => {
    console.error(`[store] [Fatal] ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
}