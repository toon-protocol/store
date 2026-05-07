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
import type { MillConfig, MillInstance } from '@toon-protocol/mill';
import type { CreateSwapHandlerConfig } from '@toon-protocol/sdk';

// --- Helper: Structured JSON logging (one object per line) ---
// Townhouse dashboard consumes container logs as a structured stream
// (`docker logs --follow | jq`). Pino is the SDK-side standard, but adding it
// as an esbuild external grows the runtime image; this 15-line helper covers
// the dashboard's needs without the bundle cost.
type LogLevel = 'info' | 'error';
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
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
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
  // embedded connector. One entry per EVM chain mill plans to settle on.
  // Shape mirrors the apex YAML chainProviders block. keyId is optional —
  // mill defaults it to the identity-derived secp256k1 hex.
  chainProviders?: ReadonlyArray<{
    chainType: 'evm';
    chainId: string;
    rpcUrl: string;
    registryAddress: string;
    tokenAddress: string;
    keyId?: string;
  }>;
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
  if (raw.parentAuthToken !== undefined) cfg.parentAuthToken = raw.parentAuthToken;
  if (raw.chainProviders) cfg.chainProviders = raw.chainProviders;

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
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
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
  if (!out.connectorUrl && env['CONNECTOR_URL']) {
    out.connectorUrl = env['CONNECTOR_URL'];
  }
  if (!out.ilpAddress && env['TOON_ILP_ADDRESS']) {
    out.ilpAddress = env['TOON_ILP_ADDRESS'];
  }
  if (!out.nodeId && env['TOON_NODE_ID']) {
    out.nodeId = env['TOON_NODE_ID'];
  }
  if (!out.parentPeerId && env['TOON_PARENT_PEER_ID']) {
    out.parentPeerId = env['TOON_PARENT_PEER_ID'];
  }
  if (out.parentAuthToken === undefined && env['TOON_PARENT_AUTH_TOKEN'] !== undefined) {
    out.parentAuthToken = env['TOON_PARENT_AUTH_TOKEN'];
  }

  return out;
}

// --- Main entrypoint ---
export async function main(): Promise<MillInstance> {
  logJson('info', 'starting');

  // Load JSON config from env or file
  const config = applyEnvOverlay(loadMillConfig());

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

  // Log structured startup line (replaces ASCII banner)
  const { pubkey, evmAddress } = instance.identity;
  const safePubkey = typeof pubkey === 'string' ? pubkey : 'unknown';
  const safeEvm = typeof evmAddress === 'string' ? evmAddress : null;
  const safeBlsPort =
    typeof instance.blsPort === 'number' ? instance.blsPort : 3200;
  logJson('info', 'mill_ready', {
    pubkey: safePubkey,
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
