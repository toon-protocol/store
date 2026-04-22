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
        .filter((e) => e && e.channelId && typeof e.cumulativeAmount !== 'undefined' && typeof e.nonce !== 'undefined')
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

  return cfg;
}

// --- Load config from env or file ---
function loadMillConfig(): MillConfig {
  const env = process.env;
  let rawConfig: CliRawConfig;

  // Priority: MILL_CONFIG_JSON > MILL_CONFIG_PATH > error
  if (env['MILL_CONFIG_JSON']) {
    try {
      rawConfig = JSON.parse(env['MILL_CONFIG_JSON']);
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
function applyEnvOverlay(cfg: MillConfig): MillConfig {
  const out = { ...cfg };
  const env = process.env;

  // Secret key (from NODE_NOSTR_SECRET_KEY)
  if (env['NODE_NOSTR_SECRET_KEY']) {
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
  if (Number.isNaN(feeBasisPoints) || feeBasisPoints < 0 || feeBasisPoints > 10000) {
    throw new Error('FEE_BASIS_POINTS must be 0-10000');
  }
  if (feeBasisPoints > 0) {
    const baseRateProvider = out.rateProvider;
    out.rateProvider = (pair) => {
      const baseRate = baseRateProvider
        ? baseRateProvider(pair)
        : 1_000_000n; // 1:1 rate (1e6 = 1 unit)
      // Apply markup as haircut: reduce output by (feeBasisPoints / 10000)
      return (baseRate * (10_000n - BigInt(feeBasisPoints))) / 10_000n;
    };
  }

  // CRITICAL: Force btpServerPort = 3000 for embedded connector
  // The standalone connector dials this port via BTP WebSocket
  out.btpServerPort = 3000;

  // DO NOT set connectorUrl — it is deferred (see Dev Notes § Connector Wiring)
  // The embedded connector is auto-created when btpServerPort is set and
  // connector/connectorUrl are both omitted.

  return out;
}

// --- Main entrypoint ---
async function main(): Promise<MillInstance> {
  console.log('[Mill Entrypoint] Starting Mill node...');

  // Load JSON config from env or file
  const config = applyEnvOverlay(loadMillConfig());

  // Validate required fields
  if (!config.secretKey && !config.mnemonic) {
    throw new Error('Either NODE_NOSTR_SECRET_KEY or mnemonic must be provided');
  }
  if (!config.swapPairs || !Array.isArray(config.swapPairs) || config.swapPairs.length === 0) {
    throw new Error('swapPairs must be non-empty array in config');
  }
  if (!config.chains || !Array.isArray(config.chains) || config.chains.length === 0) {
    throw new Error('chains must be non-empty array in config');
  }

  // Start the Mill
  const instance = await startMill(config);

  // Log startup banner
  const { pubkey, evmAddress } = instance.identity;
  const safePubkey = typeof pubkey === 'string' ? pubkey : 'unknown';
  const safeEvm = typeof evmAddress === 'string' ? evmAddress : null;
  const safeBlsPort = typeof instance.blsPort === 'number' ? instance.blsPort : 3200;
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    Mill Ready                             ║
╠═══════════════════════════════════════════════════════════╣
║ Pubkey:        ${safePubkey.slice(0, 32)}... ║
║ EVM Address:   ${safeEvm?.slice(0, 40) ?? 'N/A'} ║
║ BLS Port:      ${safeBlsPort}                                       ║
║ Swap Pairs:    ${config.swapPairs.length}                                          ║
╚═══════════════════════════════════════════════���═══════════╝
  `);

  // Clean up sensitive env vars after extraction
  delete process.env['NODE_NOSTR_SECRET_KEY'];

  // Graceful shutdown handlers (Mill CLI doesn't auto-register these)
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Mill Entrypoint] Received ${signal}, shutting down...`);
    try {
      await instance.stop();
      console.log('[Mill Entrypoint] Mill stopped gracefully');
    } catch (err) {
      console.error('[Mill Entrypoint] Error during shutdown:', err);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return instance;
}

// --- Run with error handling ---
main().catch((err) => {
  console.error(`[Mill Entrypoint] [Fatal] ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});