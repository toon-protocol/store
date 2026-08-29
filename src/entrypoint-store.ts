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

 * Registers kind:5094 Arweave blob storage, plus kind:5095 ArNS buy when
 * ARNS_DVM_SOLANA_SECRET_KEY is configured.
 *
 * The two gas-station kinds (5096 Solana, 5098 EVM) moved to
 * toon-protocol/gas-station. They were never storage: they spend this
 * node's own money on a caller's transaction, which wants its own funding,
 * its own security review and its own box.
 */

import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getPublicKey } from 'nostr-tools/pure';
import type { StoreHealthResponse } from '@toon-protocol/sdk';
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
    for (let head = events[0]; head !== undefined && head.ts < cutoff; head = events[0]) {
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

/**
 * The token Turbo credits are DENOMINATED and bought in. $ARIO is the store's
 * default (owner decision 2026-08-28): this is an ar.io app, and the credits
 * that pay for its uploads should be bought in ar.io's own token.
 *
 * This selects the CURRENCY, not the signer. The upload signer stays the
 * Arweave JWK on every path below, so the address that owns the data items —
 * and the address a Turbo balance is held against — is unchanged by flipping
 * this. What changes is the token `getTokenPriceForBytes` quotes and the token
 * an operator tops the balance up in. The winc price of a byte is identical
 * either way (verified against Turbo: 1 MiB = 11,600,114,792 winc as both
 * `arweave` and `ario`; that is 0.0178 AR or 26.59 ARIO).
 */
export type TurboCreditToken = 'ario' | 'arweave';

const TURBO_CREDIT_TOKENS: readonly TurboCreditToken[] = ['ario', 'arweave'];

export const DEFAULT_TURBO_CREDIT_TOKEN: TurboCreditToken = 'ario';

/**
 * Read `STORE_TURBO_TOKEN`, defaulting to $ARIO. Unset means ario — a box that
 * says nothing gets the ar.io token, not the historical `arweave` default.
 *
 * Fail-closed on an unrecognised value rather than silently falling back: the
 * whole turbo-sdk token union is accepted by `TurboFactory` (solana, ethereum,
 * usdc, kyve, …), so a typo'd or well-meant-but-wrong value would otherwise
 * construct a client denominated in a token nobody funded, and surface as
 * uploads failing for "no credits" against a balance that looks fine.
 */
export function resolveTurboCreditToken(
  raw: string | undefined
): TurboCreditToken {
  const value = raw?.trim();
  if (!value) return DEFAULT_TURBO_CREDIT_TOKEN;
  if ((TURBO_CREDIT_TOKENS as readonly string[]).includes(value)) {
    return value as TurboCreditToken;
  }
  throw new Error(
    `STORE_TURBO_TOKEN must be one of ${TURBO_CREDIT_TOKENS.join(', ')}, got ${JSON.stringify(value)}`
  );
}

/**
 * Base58 of a 64-byte Solana secret key (32-byte seed || 32-byte public), the
 * format `HexSolanaSigner` wants despite its name. 64 bytes encode to 87 or 88
 * base58 characters.
 *
 * Checked here rather than left to the signer so a malformed key fails at boot
 * with a message naming the variable, instead of throwing "Non-base58
 * character" from inside turbo-sdk. Note the common mistake this catches: this
 * repo stores Solana keys as HEX elsewhere (`ARNS_DVM_SOLANA_SECRET_KEY`), and
 * hex is a strict subset of nothing here -- a 128-char hex string is the wrong
 * length and usually contains `0`, which base58 does not have.
 */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function assertBase58SolanaSecret(key: string): void {
  if (!BASE58_RE.test(key)) {
    throw new Error(
      'STORE_TURBO_SOLANA_KEY must be base58 (a 64-byte Solana secret key). ' +
        'It contains characters base58 does not use — if this is the hex form, convert it.'
    );
  }
  if (key.length < 86 || key.length > 89) {
    throw new Error(
      `STORE_TURBO_SOLANA_KEY must decode to a 64-byte Solana secret key (87-88 base58 chars), got ${key.length}.`
    );
  }
}

/**
 * The address Turbo holds this account's balance against. Under `token: 'ario'`
 * that is `ownerToAddress(publicKey)` — Arweave-SHAPED base64url even when the
 * signer is a Solana keypair, which is why it is NOT the Solana pubkey the key
 * was derived from. Operators funding the account need this string, not the
 * address a Solana explorer would show them.
 *
 * Best-effort: a boot-log nicety must never be what stops the store starting.
 */
async function turboAccountAddress(client: unknown): Promise<string | undefined> {
  try {
    const c = client as { signer?: { getNativeAddress?: () => Promise<string> } };
    if (typeof c?.signer?.getNativeAddress === 'function') {
      return await c.signer.getNativeAddress();
    }
  } catch {
    // fall through
  }
  return undefined;
}

interface CreateTurboAdapterResult {
  adapter: ArweaveUploadAdapter;
  /** Source of the credentials, for boot-log diagnostics. */
  source:
    | 'ario-solana'
    | 'arweave-jwk-b64'
    | 'turbo-token-legacy'
    | 'unauthenticated-free-tier';
  /** Arweave address of the upload-signing key (only set for authenticated paths). */
  arweaveAddress?: string;
  /** The token credits are denominated in, for boot-log diagnostics. */
  token: TurboCreditToken;
  /** The constructed Turbo client (always set — every path builds one), for balance probing. */
  client?: unknown;
}

// --- Helper: Create Turbo adapter from env (preferred AR JWK path; legacy TURBO_TOKEN fallback) ---
export async function createTurboAdapter(
  arweaveJwkB64: string | undefined,
  legacyToken: string | undefined,
  creditToken: TurboCreditToken = DEFAULT_TURBO_CREDIT_TOKEN,
  solanaKeyBase58?: string | undefined
): Promise<CreateTurboAdapterResult> {
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
  const solanaKey = solanaKeyBase58?.trim() || undefined;

  // ── Preferred: STORE_TURBO_SOLANA_KEY — pay for uploads in $ARIO ──────────
  // The store is an ar.io app; this is the credential that lets it hold and
  // spend ar.io's own token for its storage, with no Arweave wallet involved.
  //
  // `createTurboSigner` maps `token: 'ario'` to a Solana signer, which signs
  // the ANS-104 data items directly — so this key, not a JWK, is what OWNS
  // every upload made under it. It is also the only path that could ever fund
  // ITSELF: `topUpWithTokens` has to sign an ARIO transfer on Solana, which an
  // ArweaveSigner cannot do.
  if (solanaKey) {
    assertBase58SolanaSecret(solanaKey);
    if (creditToken !== 'ario') {
      throw new Error(
        `STORE_TURBO_SOLANA_KEY pays in $ARIO, but STORE_TURBO_TOKEN is ${JSON.stringify(creditToken)}. ` +
          'Drop one of them: a Solana key is only a credential for the ario token.'
      );
    }
    const { TurboFactory } = await importTurbo();
    const client = TurboFactory.authenticated({
      privateKey: solanaKey,
      token: 'ario',
    });
    if (jwkB64) {
      console.warn(
        '[store] WARNING: both STORE_TURBO_SOLANA_KEY and STORE_ARWEAVE_JWK_B64 are set.' +
          ' Using the Solana key — uploads are signed by, and owned by, that wallet,' +
          ' and any credit bought against the JWK address is NOT reachable from it.'
      );
    }
    const arweaveAddress = await turboAccountAddress(client);
    return {
      adapter: new TurboUploadAdapter(client),
      source: 'ario-solana',
      ...(arweaveAddress ? { arweaveAddress } : {}),
      token: 'ario',
      client,
    };
  }

  // ── STORE_ARWEAVE_JWK_B64 (piped by the host orchestrator) ────────────────
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
      token: creditToken,
    });
    const arweaveAddress = await arweaveAddressFromJwk(jwk);
    return {
      adapter: new TurboUploadAdapter(client),
      source: 'arweave-jwk-b64',
      arweaveAddress,
      token: creditToken,
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
    const client = TurboFactory.authenticated({ privateKey: jwk as any, token: creditToken });
    const arweaveAddress = await arweaveAddressFromJwk(jwk);
    return {
      adapter: new TurboUploadAdapter(client),
      source: 'turbo-token-legacy',
      arweaveAddress,
      token: creditToken,
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
  const client = TurboFactory.authenticated({
    privateKey: ephemeralJwk,
    token: creditToken,
  });
  return {
    adapter: new TurboUploadAdapter(client),
    source: 'unauthenticated-free-tier',
    token: creditToken,
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
    const rawKind = match[1];
    if (rawKind === undefined) continue;
    const kind = parseInt(rawKind, 10);
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

/** Parsed kind:5095 configuration. */
export interface ArnsBuyEnvConfig {
  network: ArnsNetwork;
  /**
   * The DVM's funded payer wallet. Absent when the operator set no credential
   * — `op=prepare` still runs (it spends nothing), `op=buy` refuses.
   */
  solanaSecretKey?: Uint8Array;
}

/**
 * Resolve the kind:5095 config from the environment.
 *
 * This ALWAYS returns a config, because kind:5095 is always at least partly
 * served: `op=prepare` composes an unsigned transaction and needs no key, no
 * RPC and no $ARIO. Only `op=buy` — which spends the operator's money — needs
 * `ARNS_DVM_SOLANA_SECRET_KEY`, and its absence leaves `solanaSecretKey`
 * undefined rather than disabling the kind.
 *
 * A malformed value still throws: a misconfiguration must not boot a
 * silently-crippled DVM. `ARNS_NETWORK` defaults to DEVNET — mainnet is an
 * explicit opt-in.
 */
export function resolveArnsBuyEnv(
  env: NodeJS.ProcessEnv
): ArnsBuyEnvConfig {
  const hex = env['ARNS_DVM_SOLANA_SECRET_KEY']?.trim();
  if (hex && !/^[0-9a-fA-F]{128}$/.test(hex)) {
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
    ...(hex ? { solanaSecretKey: Uint8Array.from(Buffer.from(hex, 'hex')) } : {}),
  };
}

function buildNoCreditsMessage(
  address: string | undefined,
  token: TurboCreditToken = DEFAULT_TURBO_CREDIT_TOKEN
): string {
  const addr = address ?? 'unknown';
  return (
    `Turbo account ${addr} has zero credits. Uploads will fail until credits are added. ` +
    `Fund with $${token.toUpperCase()} at https://turbo.ardrive.io/ (account address: ${addr})`
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
  // Which token credits are bought in — $ARIO unless a box says otherwise.
  // Throws on an unrecognised value rather than booting mis-denominated.
  const creditToken = resolveTurboCreditToken(process.env['STORE_TURBO_TOKEN']);
  const turboSolanaKey = process.env['STORE_TURBO_SOLANA_KEY'];
  const turboResult = await createTurboAdapter(
    arweaveJwkB64,
    legacyTurboToken,
    creditToken,
    turboSolanaKey
  );

  const sourceLabel =
    turboResult.source === 'ario-solana'
      ? 'STORE_TURBO_SOLANA_KEY ($ARIO, Solana-signed)'
      : turboResult.source === 'arweave-jwk-b64'
        ? 'STORE_ARWEAVE_JWK_B64 (wallet-derived)'
        : turboResult.source === 'turbo-token-legacy'
          ? 'TURBO_TOKEN (legacy)'
          : 'unauthenticated (free tier, ≤100KB)';
  console.log(`[store] Arweave credit source: ${sourceLabel}`);
  console.log(`[store] Turbo credit token: ${turboResult.token}`);
  if (turboResult.source === 'unauthenticated-free-tier') {
    console.warn(
      '[store] WARNING: No Arweave credentials — using ephemeral JWK for free-tier uploads (≤100KB).' +
      ' Set STORE_ARWEAVE_JWK_B64 with a funded wallet to lift the size limit.' +
      ' Do NOT fund the ephemeral address — it rotates on every restart.'
    );
  }
  if (turboResult.arweaveAddress) {
    // Under `ario` this is Turbo's account address, derived from the signing
    // key — Arweave-shaped even when a Solana key signs, and NOT that key's
    // Solana pubkey. It is the string to fund against.
    console.log(`[store] Turbo account address: ${turboResult.arweaveAddress}`);
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
        if (
          wincBig === 0n &&
          (turboResult.source === 'arweave-jwk-b64' ||
            turboResult.source === 'ario-solana')
        ) {
          console.warn(
            `[store] ${buildNoCreditsMessage(turboResult.arweaveAddress, turboResult.token)}`
          );
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
  const extraHandlers: Record<number, StoreHandler> = {
    [ARNS_BUY_KIND]: counter.wrap(
      ARNS_BUY_KIND,
      createArnsBuyHandler({
        network: arnsBuyEnv.network,
        ...(arnsBuyEnv.solanaSecretKey
          ? { solanaSecretKey: arnsBuyEnv.solanaSecretKey }
          : {}),
      })
    ) as unknown as StoreHandler,
  };
  console.log(
    `[store] kind:${ARNS_BUY_KIND} ArNS enabled (network: ${arnsBuyEnv.network}; ` +
      `op=prepare always, op=buy ${arnsBuyEnv.solanaSecretKey ? 'enabled' : 'needs ARNS_DVM_SOLANA_SECRET_KEY'})`
  );
  // kind:5095 is always served — `op=prepare` needs no credential — so it is
  // always advertised. Which OPS are live is not something a list of kinds can
  // express; `op=buy` says so itself when it refuses.
  const handlerKinds = [5094, ARNS_BUY_KIND];

  // The connector is the front-of-app payment proxy: it terminates payment and
  // reverse-proxies a plain HTTP request to POST /store (RouteTermination). This
  // process contains NO ILP/BTP/connector-dialing logic.
  console.log('[store] Starting payment-oblivious POST /store backend (connector is the front payment proxy)...');
  console.log(`  handlerPort: ${config.handlerPort} (POST /store)`);
  console.log(`  blsPort: ${config.blsPort}`);
  const pubkey = getPublicKey(config.secretKey);
  const storeBackend: StoreBackend = startStoreBackend({
    handle: arweaveHandler as unknown as StoreHandler,
    ...(Object.keys(extraHandlers).length > 0 ? { handlers: extraHandlers } : {}),
    handlerPort: config.handlerPort ?? 3300,
    devMode,
  });

  // BLS health server on blsPort (3400 default) — started after the backend.
  const safePubkey = typeof pubkey === 'string' ? pubkey : 'unknown';
  const startedAt = Date.now();
  const blsPort = config.blsPort ?? 3400;

  const blsApp = new Hono();
  blsApp.get('/health', (c) => {
    const health: StoreHealthResponse = {
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