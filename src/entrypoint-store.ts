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
 *   STORE_TURBO_SOLANA_KEY -> base58 64-byte Solana secret key: the ONE Turbo
 *                            credential. Signs every upload and pays for the
 *                            above-free-tier ones in $ARIO. Treated as secret
 *                            — never logged. Unset: an ephemeral Solana key
 *                            serves the free tier only.
 *   ARNS_DVM_SOLANA_SECRET_KEY -> OPTIONAL: 128-char hex (64-byte Ed25519
 *                            keypair) of the DVM's funded Solana wallet.
 *                            When set, the kind:5095 ArNS brokered-buy job
 *                            ("buyfor" — see ./arns-buy-handler) is enabled.
 *                            Treated as secret — never logged.
 *   ARNS_NETWORK          -> devnet (default) | mainnet — which ar.io registry
 *                            the kind:5095 buys target. Mainnet is explicit
 *                            opt-in only.
 *   STORE_TURBO_SOLANA_NETWORK -> mainnet (default) | devnet -- which Solana
 *                            network, and therefore which $ARIO mint, paid
 *                            uploads spend on. Cross-checked against the
 *                            gateway at boot; a mismatch refuses to start.
 *   STORE_TURBO_SOLANA_GATEWAY -> OPTIONAL Solana RPC override for the $ARIO
 *                            path. devnet REQUIRES one naming a devnet RPC.
 *   STORE_TURBO_MAX_ARIO_PER_UPLOAD -> per-upload $ARIO ceiling for on-demand
 *                            funding. Setting it turns the paid route ON;
 *                            unset, the store serves the free tier only.
 *                            See ./turbo-funding.ts (store#123/#128).

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
  ChunkManager,
  base58Encode,
  generateSolanaKeypair,
} from '@toon-protocol/sdk';
import type { NodeConfig } from '@toon-protocol/sdk';
import { startStoreBackend, type StoreBackend, type StoreHandler } from './store-backend.js';
import {
  ARNS_BUY_KIND,
  createArnsBuyHandler,
  type ArnsNetwork,
} from './arns-buy-handler.js';
import {
  createOnDemandUploadAdapter,
  redactGatewayUrl,
  resolveTurboOnDemandEnv,
  resolveTurboSolanaNetwork,
  TURBO_FREE_TIER_MAX_BYTES,
  type TurboOnDemandClient,
  type TurboSolanaNetworkConfig,
} from './turbo-funding.js';

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

/**
 * Refuse the credentials this store no longer takes, loudly and with the
 * migration path by name (store#128 review decision: ONE Solana key, no other
 * Turbo credential). Silently ignoring a configured JWK would boot a node
 * whose operator believes a specific funded wallet signs its uploads.
 */
export function refuseRetiredTurboCredentials(env: NodeJS.ProcessEnv): void {
  const retired: [string, string][] = [
    ['STORE_ARWEAVE_JWK_B64', 'the Arweave JWK credential'],
    ['TURBO_TOKEN', 'the legacy raw-JWK credential'],
  ];
  for (const [name, what] of retired) {
    if (env[name]?.trim()) {
      throw new Error(
        `${name} is set, but ${what} was removed (store#128): the store takes ONE Turbo ` +
          'credential, a base58 Solana secret key in STORE_TURBO_SOLANA_KEY, which signs ' +
          'uploads and pays for the above-free-tier ones in $ARIO on demand. Unset it.'
      );
    }
  }
  const token = env['STORE_TURBO_TOKEN']?.trim();
  if (token && token !== 'ario') {
    throw new Error(
      `STORE_TURBO_TOKEN is ${JSON.stringify(token)}, but the store pays in $ARIO only ` +
        '(store#128); the variable is vestigial and accepts nothing but "ario". Unset it.'
    );
  }
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
  /** The raw client; the on-demand upload adapter is built over it in main(). */
  client: TurboOnDemandClient;
  /** Source of the credentials, for boot-log diagnostics. */
  source: 'ario-solana' | 'ephemeral-free-tier';
  /** Turbo's account address for the signing key (sha256-shaped, not the Solana pubkey). */
  arweaveAddress?: string;
}

// --- Helper: Create the Turbo client from the ONE credential (store#128) ---
export async function createTurboAdapter(
  solanaKeyBase58?: string | undefined,
  // Solana RPC for the $ARIO path's token operations (on-demand fund
  // transfers). Undefined keeps turbo-sdk's production default. See
  // resolveTurboSolanaNetwork for why this is validated against the stated
  // network before it gets here.
  solanaGatewayUrl?: string | undefined
): Promise<CreateTurboAdapterResult> {
  // Treat an empty OR whitespace-only env var as ABSENT, not "present but
  // invalid" (#146): a stray-whitespace value (e.g. a trailing newline from a
  // here-doc env file) must resolve to the free tier, not a base58 error.
  const solanaKey = solanaKeyBase58?.trim() || undefined;
  const { TurboFactory } = await import('@ardrive/turbo-sdk/node');

  // ── STORE_TURBO_SOLANA_KEY — the one credential ───────────────────────────
  // The store is an ar.io app; this key signs the ANS-104 data items (so it
  // OWNS every upload made under it) and, being a Solana key, is what signs
  // the $ARIO fund transfer when an above-free-tier upload buys its own
  // credits on demand. `createTurboSigner` maps `token: 'ario'` to a Solana
  // signer, which is why no other credential kind can do both jobs.
  if (solanaKey) {
    assertBase58SolanaSecret(solanaKey);
    const client = TurboFactory.authenticated({
      privateKey: solanaKey,
      token: 'ario',
      ...(solanaGatewayUrl ? { gatewayUrl: solanaGatewayUrl } : {}),
    });
    const arweaveAddress = await turboAccountAddress(client);
    return {
      client: client as unknown as TurboOnDemandClient,
      source: 'ario-solana',
      ...(arweaveAddress ? { arweaveAddress } : {}),
    };
  }

  // ── Ephemeral Solana key: free tier only, no wallet required ──────────────
  // Turbo grants free small-data-item uploads to ANY valid signer regardless
  // of balance, so a keyless box still serves the ≤107,520-byte tier. The key
  // rotates on every restart, holds no $ARIO, and cannot be funded — which is
  // fine, because the paid route additionally requires the per-upload ceiling
  // to be configured, and main() refuses to combine that with this path.
  const ephemeral = generateSolanaKeypair();
  const client = TurboFactory.authenticated({
    privateKey: base58Encode(ephemeral.secretKey),
    token: 'ario',
    ...(solanaGatewayUrl ? { gatewayUrl: solanaGatewayUrl } : {}),
  });
  return {
    client: client as unknown as TurboOnDemandClient,
    source: 'ephemeral-free-tier',
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

  // Build the Arweave upload adapter (store#128: ONE credential, pay per
  // upload). A retired credential in the environment is a loud refusal, not a
  // silently ignored variable.
  refuseRetiredTurboCredentials(process.env);
  const turboSolanaKey = process.env['STORE_TURBO_SOLANA_KEY'];
  // Which Solana network the node pays on is a stated decision (store#123):
  // a network/gateway mismatch is a refuse-to-start, never a silent wrong mint.
  const turboNetwork: TurboSolanaNetworkConfig = resolveTurboSolanaNetwork(process.env);
  // Per-upload spend authority; a malformed value throws here, before
  // anything is constructed.
  const onDemandEnv = resolveTurboOnDemandEnv(process.env);
  const turboResult = await createTurboAdapter(turboSolanaKey, turboNetwork.gatewayUrl);

  // The paid route spends the wallet's $ARIO, which only the configured key
  // holds. Asking for it on the ephemeral path is a misconfiguration to
  // refuse, not degrade (the operator asked for a node that pays for uploads
  // and would get one that silently cannot).
  if (onDemandEnv.paidUploadsEnabled && turboResult.source !== 'ario-solana') {
    throw new Error(
      'STORE_TURBO_MAX_ARIO_PER_UPLOAD requires the $ARIO credential (STORE_TURBO_SOLANA_KEY): ' +
        'a paid upload signs a Solana fund transfer, which the ephemeral free-tier key cannot pay for.'
    );
  }

  const sourceLabel =
    turboResult.source === 'ario-solana'
      ? 'STORE_TURBO_SOLANA_KEY ($ARIO, Solana-signed)'
      : `ephemeral Solana key (free tier, ≤${TURBO_FREE_TIER_MAX_BYTES} bytes signed)`;
  console.log(`[store] Arweave upload credential: ${sourceLabel}`);
  // One glance answers "which token, on which network, can it pay" (story
  // 10). The gateway is logged as origin only: RPC providers put the API key
  // in the path or query.
  console.log(
    `[store] Turbo Solana network: ${turboNetwork.network} ($ARIO mint ${turboNetwork.mint}` +
      `${turboNetwork.gatewayUrl ? `, gateway ${redactGatewayUrl(turboNetwork.gatewayUrl)}` : ''})`
  );
  if (turboResult.source === 'ephemeral-free-tier') {
    console.warn(
      `[store] WARNING: no Turbo credential — an ephemeral Solana key serves free-tier uploads ` +
        `(≤${TURBO_FREE_TIER_MAX_BYTES} bytes signed). Set STORE_TURBO_SOLANA_KEY (and a per-upload ` +
        'ceiling) to serve larger ones. Do NOT fund the ephemeral address — it rotates on every restart.'
    );
  }
  if (turboResult.arweaveAddress) {
    // Turbo's account address for this key — sha256-shaped even though a
    // Solana key signs, and NOT the Solana pubkey an explorer shows. On the
    // on-demand path nothing needs manual funding (the wallet's $ARIO pays
    // per upload), but the address is what Turbo support and balance queries
    // key off, so it belongs in the boot log.
    console.log(`[store] Turbo account address: ${turboResult.arweaveAddress}`);
  }
  console.log(
    onDemandEnv.paidUploadsEnabled
      ? `[store] paid uploads: ON DEMAND, at most ${onDemandEnv.maxArioPerUpload} $ARIO per upload ` +
          '(each above-free-tier upload buys exactly its own credits; no standing balance)'
      : '[store] paid uploads: OFF (no STORE_TURBO_MAX_ARIO_PER_UPLOAD; above-free-tier uploads are refused by name)'
  );

  // Route by the SIGNED-item size: free tier at or under the ceiling, bounded
  // on-demand $ARIO above it (or a named refusal with no spend authority).
  // Sits behind the existing adapter seam; the job handler knows nothing.
  const uploadAdapter = createOnDemandUploadAdapter({
    client: turboResult.client,
    // token:'ario' signs with the Solana key on both paths, so the free-tier
    // ceiling is measured against the ed25519 envelope.
    signerKind: 'solana-ed25519',
    ...(onDemandEnv.paidUploadsEnabled && onDemandEnv.maxArioPerUpload !== undefined
      ? { maxArioPerUpload: onDemandEnv.maxArioPerUpload }
      : {}),
  });

  const chunkManager = new ChunkManager(); // in-memory, v1

  const arweaveConfig: ArweaveDvmConfig = {
    turboAdapter: uploadAdapter,
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

  // Story 18: a funding wallet shared with ArNS is supported but warned
  // about -- an upload top-up and a name purchase then compete for one
  // balance. Compare public halves only; neither secret is logged.
  if (turboSolanaKey?.trim() && arnsBuyEnv.solanaSecretKey) {
    try {
      const { base58Decode } = await import('@toon-protocol/sdk');
      const turboPub = base58Decode(turboSolanaKey.trim()).slice(32);
      const arnsPub = arnsBuyEnv.solanaSecretKey.slice(32);
      if (
        turboPub.length === 32 &&
        Buffer.from(turboPub).equals(Buffer.from(arnsPub))
      ) {
        console.warn(
          '[store] WARNING: STORE_TURBO_SOLANA_KEY and ARNS_DVM_SOLANA_SECRET_KEY are the SAME wallet. ' +
            'Upload top-ups and ArNS purchases will spend from one $ARIO balance.'
        );
      }
    } catch {
      // A comparison nicety must never stop the store starting.
    }
  }
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
    // StoreHealthResponse plus the Turbo funding block (store#123/#128): the
    // funding MODEL, stated. With per-upload on-demand funding there is no
    // standing balance to report, and /health is world-readable behind nginx,
    // so the block carries configuration facts only — never upstream error
    // text, which routinely embeds RPC URLs (and Helius/QuickNode put the API
    // key in the URL). The extra field is additive, so existing consumers of
    // the canonical type are unaffected.
    const health: StoreHealthResponse & {
      turbo: {
        source: string;
        token: string;
        network: string;
        mint: string;
        freeTierMaxBytes: number;
        paidUploads: 'on-demand' | 'off';
        maxArioPerUpload?: number;
        accountAddress?: string;
      };
    } = {
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
      turbo: {
        source: turboResult.source,
        token: 'ario',
        network: turboNetwork.network,
        mint: turboNetwork.mint,
        freeTierMaxBytes: TURBO_FREE_TIER_MAX_BYTES,
        paidUploads: onDemandEnv.paidUploadsEnabled ? 'on-demand' : 'off',
        ...(onDemandEnv.maxArioPerUpload !== undefined
          ? { maxArioPerUpload: onDemandEnv.maxArioPerUpload }
          : {}),
        ...(turboResult.arweaveAddress
          ? { accountAddress: turboResult.arweaveAddress }
          : {}),
      },
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
  delete process.env['STORE_TURBO_SOLANA_KEY'];

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