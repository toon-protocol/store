/**
 * Mill Node Entrypoint Adapter (Story 21.6)
 *
 * Maps Townhouse orchestrator environment variables to Mill config,
 * loads JSON config from MILL_CONFIG_JSON or MILL_CONFIG_PATH,
 * and invokes startMill() programmatically.
 *
 * This is compiled via esbuild into a single ESM bundle for the Docker
 * runtime stage.
 *
 * Environment variable mapping:
 *   MILL_CONFIG_JSON      -> JSON config (mutually exclusive with MILL_CONFIG_PATH)
 *   MILL_CONFIG_PATH      -> Path to JSON config file
 *   NODE_NOSTR_SECRET_KEY -> config.secretKey (64-char hex)
 *   BLS_PORT              -> config.blsPort (default: 3200)
 *   MILL_RELAYS           -> config.relayUrls (comma-separated)
 *   FEE_BASIS_POINTS      -> applied as markup via config.rateProvider
 *   (btpServerPort)       -> HARDCODED to 3000 (embedded connector)
 */

import { readFileSync } from 'node:fs';
import { startMill } from '@toon-protocol/mill';
import type {
  MillConfig,
  MillChainProvider,
  MillInstance,
} from '@toon-protocol/mill';
import type { CreateSwapHandlerConfig } from '@toon-protocol/sdk';

// --- Helper: Structured JSON logging (one object per line) ---
// Townhouse dashboard consumes container logs as a structured stream
// (`docker logs --follow | jq`). Pino is the SDK-side standard, but adding it
// as an esbuild external grows the runtime image; this 15-line helper covers
// the dashboard's needs without the bundle cost.
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export function logJson(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>
): void {
  const line =
    JSON.stringify({
      ts: Date.now(),
      level,
      scope: 'mill-entrypoint',
      msg,
      ...fields,
    }) + '\n';
  // warn/error → stderr so failures (e.g. a never-stored kind:10032
  // advertisement, Story 50.4 AC #2) surface on the operator's error stream.
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

/**
 * Adapt {@link logJson} to the `MillLogger` shape `startMill()` expects, so
 * Mill's internal diagnostics (including kind:10032 advertisement
 * success/failure) reach the container log stream instead of being swallowed
 * by `startMill()`'s default no-op logger (Story 50.4 AC #2).
 *
 * Two calling conventions reach this logger and BOTH must serialize cleanly
 * (issue #87 — a live T00 swap reject was undebuggable because the structured
 * payload collapsed to `[object Object]`):
 *
 *   1. String-first (mill.ts internal calls):
 *        logger.warn('mill.peerInfo.publish_failed', { err: '...' })
 *   2. Object-first / pino merging-object (SDK swap-handler + claim issuer):
 *        logger.error({ event: 'swap_handler.issuer_failed', err: '...' })
 *
 * For (2) we must NOT `String(payload)` (that yields `[object Object]` and
 * loses every field). Instead we lift the payload's `event`/`msg` to the log
 * message and spread the rest of its fields so the event name and error
 * details survive in the structured line.
 */
export function millEntrypointLogger(): NonNullable<MillConfig['logger']> {
  const at =
    (level: LogLevel) =>
    (...args: unknown[]): void => {
      const first = args[0];
      // Convention (2): object-first (pino merging object). Lift `event`/`msg`
      // to the message and keep the remaining fields structured so swap_handler.*
      // diagnostics (event names + error details) survive in the log line.
      if (first && typeof first === 'object') {
        const payload = first as Record<string, unknown>;
        const { event, msg, ...rest } = payload;
        const message =
          typeof event === 'string'
            ? event
            : typeof msg === 'string'
              ? msg
              : 'log';
        // A pino merging object may be followed by a format string
        // (logger.error({ ... }, 'message')); fold it into the message.
        const tail = typeof args[1] === 'string' ? args[1] : undefined;
        logJson(level, tail ? `${message}: ${tail}` : message, rest);
        return;
      }
      // Convention (1): string-first.
      const message = typeof first === 'string' ? first : String(first);
      const fields =
        args[1] && typeof args[1] === 'object'
          ? (args[1] as Record<string, unknown>)
          : undefined;
      logJson(level, message, fields);
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}

// --- Helper: Convert value to BigInt (mirrors cli.ts) ---
function toBigInt(v: unknown): bigint {
  if (v === null || v === undefined) {
    throw new Error(`Cannot convert to bigint: ${v}`);
  }
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') {
    // Handle scientific notation (e.g., "1e6") before BigInt
    const parsed = parseFloat(v);
    if (!Number.isNaN(parsed) && parsed.toString() === v) {
      return BigInt(parsed);
    }
    return BigInt(v);
  }
  throw new Error(`Cannot convert to bigint: ${String(v)}`);
}

// --- Helper: Reject prototype-polluting keys ---
function assertSafeKey(key: string, scope: string): void {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error(
      `Unsafe key "${key}" rejected in ${scope} (prototype pollution guard)`
    );
  }
}

// --- Raw config shape (mirrors cli.ts CliRawConfig) ---
interface CliRawConfig {
  mnemonic?: string;
  secretKey?: string; // hex
  swapPairs?: unknown;
  chains?: unknown;
  channels?: Record<
    string,
    {
      channelId: string;
      cumulativeAmount: string | number;
      nonce: string | number;
      updatedAt?: number;
    }[]
  >;
  inventory?: Record<string, string | number>;
  relayUrls?: string[];
  blsPort?: number;
  passphrase?: string;
  knownPeers?: { ilpAddress: string; btpUrl?: string }[];
  ilpAddress?: string;
  btpEndpoint?: string;
  advertisedAsset?: { assetCode: string; assetScale: number };
  transport?: {
    type: string;
    socksProxy?: string;
    externalUrl?: string;
    managed?: boolean;
    managedOptions?: Record<string, unknown>;
  };
  // Rate provider for swap fee configuration
  rateProvider?: CreateSwapHandlerConfig['rateProvider'];
  // Parent-connector peering (embedded-with-parent mode). When connectorUrl
  // is set, the embedded ConnectorNode dials this URL as a BTP peer and
  // installs a self-route on ilpAddress for local delivery.
  connectorUrl?: string;
  nodeId?: string;
  parentPeerId?: string;
  parentAuthToken?: string;
  // chainProviders for ClaimReceiver + PerPacketClaimService init on the
  // embedded connector. One entry per chain mill plans to settle on (EVM /
  // Solana / Mina). Shape mirrors the apex YAML chainProviders block (the
  // connector's ChainProviderConfigEntry discriminated union). keyId is
  // optional — mill defaults it to the identity-derived secp256k1 hex.
  chainProviders?: readonly MillChainProvider[];
  // Embedded-connector ClaimReceiver / chainProviders signer. When set
  // (typically via SETTLEMENT_PRIVATE_KEY env), the embedded connector
  // signs claims with this key in place of the identity hex.
  settlementPrivateKey?: string;
  // EVM treasury address advertised to the apex parent peer entry — the
  // apex's PerPacketClaimService will use this as peerAddress on
  // outbound channel-open calls.
  parentEvmAddress?: string;
  // Story 50.4 — ILP address of the relay node that stores the kind:10032
  // advertisement (e.g. the apex `g.townhouse`). When set, Mill advertises via
  // an ILP PREPARE through its embedded connector instead of an unpaid Nostr
  // WS publish (which a pay-to-write TOON relay rejects).
  peerInfoIlpDestination?: string;
  // Story 50.4 — per-byte price for the kind:10032 ILP advertisement amount.
  peerInfoPricePerByte?: string | number;
}

// --- Parse and normalize raw config ---
function parseRawConfig(raw: CliRawConfig): MillConfig {
  // Normalize channels: string/number → bigint
  const channels: MillConfig['channels'] = Object.create(null);
  if (raw.channels) {
    for (const [chain, entries] of Object.entries(raw.channels)) {
      assertSafeKey(chain, 'channels');
      if (!Array.isArray(entries)) continue;
      channels[chain] = entries
        .filter(
          (e) =>
            e &&
            e.channelId &&
            typeof e.cumulativeAmount !== 'undefined' &&
            typeof e.nonce !== 'undefined'
        )
        .map((e) => ({
          channelId: e.channelId,
          cumulativeAmount: toBigInt(e.cumulativeAmount),
          nonce: toBigInt(e.nonce),
          updatedAt: e.updatedAt ?? 0,
        }));
    }
  }

  // Normalize inventory
  const inventory: Record<string, bigint> = Object.create(null);
  if (raw.inventory) {
    for (const [chain, amt] of Object.entries(raw.inventory)) {
      assertSafeKey(chain, 'inventory');
      if (amt === null || amt === undefined) continue;
      inventory[chain] = toBigInt(amt);
    }
  }

  const cfg: MillConfig = {
    swapPairs: (raw.swapPairs as MillConfig['swapPairs']) ?? [],
    chains: (raw.chains as MillConfig['chains']) ?? [],
    channels,
    inventory,
    relayUrls: raw.relayUrls ?? [],
  };

  if (raw.mnemonic) cfg.mnemonic = raw.mnemonic;
  if (raw.secretKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(raw.secretKey)) {
      throw new Error(
        'config.secretKey must be a 64-character hex string (32 bytes)'
      );
    }
    cfg.secretKey = Uint8Array.from(Buffer.from(raw.secretKey, 'hex'));
  }
  if (raw.blsPort !== undefined) cfg.blsPort = raw.blsPort;
  if (raw.passphrase) cfg.passphrase = raw.passphrase;
  if (raw.knownPeers) cfg.knownPeers = raw.knownPeers;
  if (raw.ilpAddress) cfg.ilpAddress = raw.ilpAddress;
  if (raw.btpEndpoint) cfg.btpEndpoint = raw.btpEndpoint;
  if (raw.advertisedAsset) cfg.advertisedAsset = raw.advertisedAsset;
  if (raw.transport) cfg.transport = raw.transport as MillConfig['transport'];
  if (raw.rateProvider) cfg.rateProvider = raw.rateProvider;
  if (raw.connectorUrl) cfg.connectorUrl = raw.connectorUrl;
  if (raw.nodeId) cfg.nodeId = raw.nodeId;
  if (raw.parentPeerId) cfg.parentPeerId = raw.parentPeerId;
  if (raw.parentAuthToken !== undefined)
    cfg.parentAuthToken = raw.parentAuthToken;
  if (raw.chainProviders) cfg.chainProviders = raw.chainProviders;
  if (raw.settlementPrivateKey)
    cfg.settlementPrivateKey = raw.settlementPrivateKey;
  if (raw.parentEvmAddress) cfg.parentEvmAddress = raw.parentEvmAddress;
  if (raw.peerInfoIlpDestination)
    cfg.peerInfoIlpDestination = raw.peerInfoIlpDestination;
  if (raw.peerInfoPricePerByte !== undefined) {
    // Mirror the env-path validation (applyEnvOverlay): a fractional value
    // throws a friendly error instead of an opaque BigInt RangeError, and a
    // negative value is rejected before it becomes a negative ILP amount.
    let ppb: bigint;
    try {
      ppb = toBigInt(raw.peerInfoPricePerByte);
    } catch {
      throw new Error('peerInfoPricePerByte must be an integer');
    }
    if (ppb < 0n) {
      throw new Error('peerInfoPricePerByte must be non-negative');
    }
    cfg.peerInfoPricePerByte = ppb;
  }

  return cfg;
}

// --- Load config from env or file ---
export function loadMillConfig(): MillConfig {
  const env = process.env;
  let rawConfig: CliRawConfig;

  // Priority: MILL_CONFIG_JSON > MILL_CONFIG_PATH > error
  if (env['MILL_CONFIG_JSON']) {
    try {
      rawConfig = JSON.parse(env['MILL_CONFIG_JSON']);
      // Fail-closed: drop the env var immediately after JSON.parse returns
      // (whether rawConfig is truthy or falsy) so a later throw cannot leave
      // secret material (mnemonic, secretKey, channel state) in process.env
      // memory. Placed before the null-guard so JSON.parse('null') also cleans
      // up. MILL_CONFIG_PATH is intentionally NOT cleaned — a path is not secret.

      delete process.env['MILL_CONFIG_JSON'];
      if (!rawConfig) {
        throw new Error('MILL_CONFIG_JSON parsed to null or undefined');
      }
    } catch (err) {
      throw new Error(
        `Failed to parse MILL_CONFIG_JSON: ${err instanceof Error ? err.message : err}`
      );
    }
  } else if (env['MILL_CONFIG_PATH']) {
    const configPath = env['MILL_CONFIG_PATH'];
    try {
      const content = readFileSync(configPath, 'utf-8');
      if (!content.trim()) {
        throw new Error('MILL_CONFIG_PATH file is empty');
      }
      rawConfig = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `Failed to read MILL_CONFIG_PATH (${configPath}): ${err instanceof Error ? err.message : err}`
      );
    }
  } else {
    throw new Error(
      'MILL_CONFIG_JSON or MILL_CONFIG_PATH must be provided. ' +
        'Expected config shape: { swapPairs, chains, channels, inventory, relayUrls, ... }'
    );
  }

  return parseRawConfig(rawConfig);
}

// --- Apply env var overlays to config ---
export function applyEnvOverlay(cfg: MillConfig): MillConfig {
  const out = { ...cfg };
  const env = process.env;

  // MILL_MNEMONIC takes priority — required for BIP-32 swap key derivation.
  // NODE_NOSTR_SECRET_KEY is accepted as a fallback for identity-only starts
  // (no swap key derivation), but startMill() will throw MILL_REQUIRES_MNEMONIC
  // unless a mnemonic is present.
  if (env['MILL_MNEMONIC'] && env['MILL_MNEMONIC'].trim()) {
    out.mnemonic = env['MILL_MNEMONIC'].trim();
    delete out.secretKey;
  } else if (env['NODE_NOSTR_SECRET_KEY']) {
    const hex = env['NODE_NOSTR_SECRET_KEY'];
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('NODE_NOSTR_SECRET_KEY must be a 64-char hex string');
    }
    out.secretKey = Uint8Array.from(Buffer.from(hex, 'hex'));
    delete out.mnemonic;
  }

  // BLS port (default 3200)
  if (env['BLS_PORT']) {
    const p = parseInt(env['BLS_PORT'], 10);
    if (!Number.isFinite(p) || p < 0 || p > 65535) {
      throw new Error('BLS_PORT must be 0..65535');
    }
    out.blsPort = p;
  } else if (out.blsPort === undefined) {
    out.blsPort = 3200;
  }

  // Relay URLs (comma-separated)
  if (env['MILL_RELAYS'] && env['MILL_RELAYS'].trim()) {
    out.relayUrls = env['MILL_RELAYS']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Fee markup via rateProvider wrapping
  const feeBasisPoints = parseInt(env['FEE_BASIS_POINTS'] ?? '0', 10);
  if (
    Number.isNaN(feeBasisPoints) ||
    feeBasisPoints < 0 ||
    feeBasisPoints > 10000
  ) {
    throw new Error('FEE_BASIS_POINTS must be 0-10000');
  }
  if (feeBasisPoints > 0) {
    const baseRateProvider = out.rateProvider;
    out.rateProvider = (pair) => {
      const baseRate = baseRateProvider ? baseRateProvider(pair) : 1_000_000n; // 1:1 rate (1e6 = 1 unit)
      // Apply markup as haircut: reduce output by (feeBasisPoints / 10000)
      return (baseRate * (10_000n - BigInt(feeBasisPoints))) / 10_000n;
    };
  }

  // CRITICAL: Force btpServerPort = 3000 for embedded connector
  // The standalone connector dials this port via BTP WebSocket
  out.btpServerPort = 3000;

  // Env-var passthroughs for embedded-with-parent mode. JSON config wins
  // when both are set.
  // Accept the legacy `CONNECTOR_URL` and the `TOON_`-prefixed alias used by
  // the townhouse orchestrator / E2E harness (Story 50.4), matching the other
  // TOON_-prefixed passthroughs below. CONNECTOR_URL wins when both are set.
  if (
    !out.connectorUrl &&
    (env['CONNECTOR_URL'] || env['TOON_CONNECTOR_URL'])
  ) {
    out.connectorUrl = env['CONNECTOR_URL'] ?? env['TOON_CONNECTOR_URL'];
  }
  // Accept the unprefixed `ILP_ADDRESS` / `NODE_ID` the townhouse compose
  // templates set on the mill service (mirroring entrypoint-town's mapping),
  // alongside the `TOON_`-prefixed aliases. The `ILP_ADDRESS` mapping is
  // load-bearing (issue #157): without it the mill's embedded connector
  // defaults its self-route to `g.toon.mill.<pubkey>`, which does NOT match the
  // address the apex forwards swaps to (`g.townhouse.mill`). The mismatch makes
  // the inbound swap PREPARE miss the self-route and fall through to the
  // default-up-to-parent route, where the per-packet-claim-service tries (and
  // fails) to open an OUTBOUND channel back to the parent `g.townhouse`,
  // rejecting with `T00 No payment channel available for peer`. Setting
  // `ilpAddress = g.townhouse.mill` keeps the swap on the local self-route so it
  // reaches the swap-handler (fee-zeroed local delivery). JSON config /
  // TOON_-prefixed env win when both are set.
  if (!out.ilpAddress && (env['TOON_ILP_ADDRESS'] || env['ILP_ADDRESS'])) {
    out.ilpAddress = env['TOON_ILP_ADDRESS'] ?? env['ILP_ADDRESS'];
  }
  if (!out.nodeId && (env['TOON_NODE_ID'] || env['NODE_ID'])) {
    out.nodeId = env['TOON_NODE_ID'] ?? env['NODE_ID'];
  }
  if (!out.parentPeerId && env['TOON_PARENT_PEER_ID']) {
    out.parentPeerId = env['TOON_PARENT_PEER_ID'];
  }
  if (
    out.parentAuthToken === undefined &&
    env['TOON_PARENT_AUTH_TOKEN'] !== undefined
  ) {
    out.parentAuthToken = env['TOON_PARENT_AUTH_TOKEN'];
  }

  // Settlement signer + parent peer EVM treasury — both safe to ship via
  // env (private key is sensitive but already accepted as MILL_MNEMONIC /
  // NODE_NOSTR_SECRET_KEY above; address is public). JSON config wins.
  if (!out.settlementPrivateKey && env['SETTLEMENT_PRIVATE_KEY']) {
    const v = env['SETTLEMENT_PRIVATE_KEY'];
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
      throw new Error(
        'SETTLEMENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'
      );
    }
    out.settlementPrivateKey = v;
  }
  if (!out.parentEvmAddress && env['PARENT_EVM_ADDRESS']) {
    const v = env['PARENT_EVM_ADDRESS'];
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
      throw new Error(
        'PARENT_EVM_ADDRESS must be a 0x-prefixed 20-byte hex address'
      );
    }
    out.parentEvmAddress = v;
  }

  // Story 50.4 — kind:10032 ILP advertisement target. JSON config wins.
  if (!out.peerInfoIlpDestination && env['TOON_PEERINFO_ILP_ADDRESS']) {
    out.peerInfoIlpDestination = env['TOON_PEERINFO_ILP_ADDRESS'];
  }
  if (
    out.peerInfoPricePerByte === undefined &&
    env['TOON_PEERINFO_PRICE_PER_BYTE'] !== undefined &&
    env['TOON_PEERINFO_PRICE_PER_BYTE'] !== ''
  ) {
    const v = env['TOON_PEERINFO_PRICE_PER_BYTE'];
    try {
      out.peerInfoPricePerByte = BigInt(v);
    } catch {
      throw new Error('TOON_PEERINFO_PRICE_PER_BYTE must be an integer');
    }
    if (out.peerInfoPricePerByte < 0n) {
      throw new Error('TOON_PEERINFO_PRICE_PER_BYTE must be non-negative');
    }
  }

  return out;
}

// --- Main entrypoint ---
export async function main(): Promise<MillInstance> {
  logJson('info', 'starting');

  // Load JSON config from env or file
  const config = applyEnvOverlay(loadMillConfig());

  // Surface Mill's internal diagnostics (kind:10032 advertisement, connector
  // start, publish failures) on the container log stream (Story 50.4 AC #2).
  if (!config.logger) {
    config.logger = millEntrypointLogger();
  }

  // Validate required fields
  if (!config.secretKey && !config.mnemonic) {
    throw new Error(
      'Either NODE_NOSTR_SECRET_KEY or mnemonic must be provided'
    );
  }
  if (
    !config.swapPairs ||
    !Array.isArray(config.swapPairs) ||
    config.swapPairs.length === 0
  ) {
    throw new Error('swapPairs must be non-empty array in config');
  }
  if (
    !config.chains ||
    !Array.isArray(config.chains) ||
    config.chains.length === 0
  ) {
    throw new Error('chains must be non-empty array in config');
  }

  // Start the Mill
  const instance = await startMill(config);

  // Log structured startup line (replaces ASCII banner).
  //
  // `instance.identity` is derived from MILL_MNEMONIC (see mill.ts:
  // `const identity = fromMnemonic(config.mnemonic)`), and that SAME identity
  // is used as the swap-handler gift-wrap recipient (`recipientSecretKey:
  // identity.secretKey`) AND published as the kind:10032 IlpPeerInfo `pubkey`.
  // So this pubkey is the key a streamSwap caller must encrypt (NIP-59
  // gift-wrap) to and pass as `millPubkey` — it is the MILL_MNEMONIC identity,
  // NOT the NODE_NOSTR_SECRET_KEY-derived node nostr identity. Issues #80/#88:
  // we surface it under the unambiguous `swapRecipientPubkey` field (keeping
  // `pubkey` for back-compat) so a copy/paste from logs targets the right key.
  const { pubkey, evmAddress } = instance.identity;
  const safePubkey = typeof pubkey === 'string' ? pubkey : 'unknown';
  const safeEvm = typeof evmAddress === 'string' ? evmAddress : null;
  const safeBlsPort =
    typeof instance.blsPort === 'number' ? instance.blsPort : 3200;
  logJson('info', 'mill_ready', {
    pubkey: safePubkey,
    // Explicit alias: the MILL_MNEMONIC-derived gift-wrap recipient that
    // streamSwap callers must use as `millPubkey` (== kind:10032 IlpPeerInfo
    // pubkey). Distinct from the node's NODE_NOSTR_SECRET_KEY nostr identity.
    swapRecipientPubkey: safePubkey,
    evmAddress: safeEvm,
    blsPort: safeBlsPort,
    swapPairCount: config.swapPairs.length,
  });

  // Clean up sensitive env vars after extraction
  delete process.env['NODE_NOSTR_SECRET_KEY'];

  // Graceful shutdown handlers (Mill CLI doesn't auto-register these)
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logJson('info', 'shutdown_received', { signal });
    try {
      await instance.stop();
      logJson('info', 'shutdown_complete');
    } catch (err) {
      logJson('error', 'shutdown_error', { err: String(err) });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // SIGQUIT is sent by `kill -3` and some k8s liveness-probe failure paths.
  // Registering costs one line and prevents shutdown() being skipped there.
  process.on('SIGQUIT', () => shutdown('SIGQUIT'));

  return instance;
}

// --- Run with error handling ---
// Gated so importing this module from a test (Vitest sets VITEST=true) does
// not trigger the IIFE — tests import the exported helpers and call them
// directly with mocks.
if (!process.env['VITEST']) {
  main().catch((err) => {
    logJson('error', 'fatal', {
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}
