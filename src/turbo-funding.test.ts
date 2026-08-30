/**
 * Unit tests for turbo-funding.ts (store#123).
 *
 * Everything here drives the exported functions against stubs; no test ever
 * reaches a chain, a Turbo, or a clock it does not control. The seam under
 * test is the same one #122's suite established: what was constructed, what
 * was decided, and what was reported.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  ARIO_MINTS,
  TURBO_FREE_TIER_MAX_BYTES,
  createFundedUploadAdapter,
  createTurboFundingMonitor,
  resolveTurboFundingEnv,
  resolveTurboSolanaNetwork,
  wincToCapacityBytes,
  type TurboFundingEnvConfig,
} from './turbo-funding.js';

// ---------------------------------------------------------------------------
// resolveTurboSolanaNetwork — network and mint are decisions, not inferences
// ---------------------------------------------------------------------------

describe('resolveTurboSolanaNetwork', () => {
  it('defaults to mainnet with the mainnet mint', () => {
    const cfg = resolveTurboSolanaNetwork({});
    expect(cfg.network).toBe('mainnet');
    expect(cfg.mint).toBe(ARIO_MINTS.mainnet);
    expect(cfg.gatewayUrl).toBeUndefined();
  });

  it('accepts an explicit mainnet gateway', () => {
    const cfg = resolveTurboSolanaNetwork({
      STORE_TURBO_SOLANA_NETWORK: 'mainnet',
      STORE_TURBO_SOLANA_GATEWAY: 'https://solana-rpc.publicnode.com',
    });
    expect(cfg.gatewayUrl).toBe('https://solana-rpc.publicnode.com');
    expect(cfg.mint).toBe(ARIO_MINTS.mainnet);
  });

  it('refuses to start on mainnet with a devnet gateway', () => {
    // The mismatch that would otherwise fail silently in production: turbo-sdk
    // picks the mint by the "devnet" substring, so this combination spends a
    // token nobody funded.
    expect(() =>
      resolveTurboSolanaNetwork({
        STORE_TURBO_SOLANA_NETWORK: 'mainnet',
        STORE_TURBO_SOLANA_GATEWAY: 'https://api.devnet.solana.com',
      })
    ).toThrow(/devnet/);
  });

  it('refuses devnet without an explicit devnet gateway', () => {
    expect(() =>
      resolveTurboSolanaNetwork({ STORE_TURBO_SOLANA_NETWORK: 'devnet' })
    ).toThrow(/devnet/);
    expect(() =>
      resolveTurboSolanaNetwork({
        STORE_TURBO_SOLANA_NETWORK: 'devnet',
        STORE_TURBO_SOLANA_GATEWAY: 'https://api.mainnet-beta.solana.com',
      })
    ).toThrow(/devnet/);
  });

  it('selects the devnet mint when devnet is stated consistently', () => {
    const cfg = resolveTurboSolanaNetwork({
      STORE_TURBO_SOLANA_NETWORK: 'devnet',
      STORE_TURBO_SOLANA_GATEWAY: 'https://api.devnet.solana.com',
    });
    expect(cfg.network).toBe('devnet');
    expect(cfg.mint).toBe(ARIO_MINTS.devnet);
  });

  it('rejects an unrecognised network by name', () => {
    expect(() =>
      resolveTurboSolanaNetwork({ STORE_TURBO_SOLANA_NETWORK: 'testnet' })
    ).toThrow(/STORE_TURBO_SOLANA_NETWORK/);
  });
});

// ---------------------------------------------------------------------------
// resolveTurboFundingEnv — opt-in, bounded, fail-closed on misconfiguration
// ---------------------------------------------------------------------------

describe('resolveTurboFundingEnv', () => {
  it('is fully off by default', () => {
    const cfg = resolveTurboFundingEnv({});
    expect(cfg.selfFundingEnabled).toBe(false);
    expect(cfg.thresholdWinc).toBeUndefined();
    expect(cfg.topUpAmountArio).toBeUndefined();
    expect(cfg.minIntervalMs).toBe(3600 * 1000);
    expect(cfg.checkIntervalMs).toBe(600 * 1000);
  });

  it('threshold alone means warn-only monitoring', () => {
    const cfg = resolveTurboFundingEnv({
      STORE_TURBO_TOPUP_THRESHOLD_WINC: '1000000000',
    });
    expect(cfg.thresholdWinc).toBe(1_000_000_000n);
    expect(cfg.selfFundingEnabled).toBe(false);
  });

  it('amount plus threshold enables self-funding', () => {
    const cfg = resolveTurboFundingEnv({
      STORE_TURBO_TOPUP_THRESHOLD_WINC: '1000000000',
      STORE_TURBO_TOPUP_AMOUNT_ARIO: '50',
      STORE_TURBO_TOPUP_MAX_ARIO: '100',
      STORE_TURBO_TOPUP_MIN_INTERVAL_SEC: '120',
      STORE_TURBO_BALANCE_CHECK_INTERVAL_SEC: '30',
    });
    expect(cfg.selfFundingEnabled).toBe(true);
    expect(cfg.topUpAmountArio).toBe(50);
    expect(cfg.maxTopUpArio).toBe(100);
    expect(cfg.minIntervalMs).toBe(120_000);
    expect(cfg.checkIntervalMs).toBe(30_000);
  });

  it('refuses an amount with no threshold', () => {
    expect(() =>
      resolveTurboFundingEnv({ STORE_TURBO_TOPUP_AMOUNT_ARIO: '50' })
    ).toThrow(/THRESHOLD/);
  });

  it('refuses a ceiling with no amount', () => {
    expect(() =>
      resolveTurboFundingEnv({ STORE_TURBO_TOPUP_MAX_ARIO: '100' })
    ).toThrow(/AMOUNT/);
  });

  it('refuses malformed numbers by variable name', () => {
    expect(() =>
      resolveTurboFundingEnv({ STORE_TURBO_TOPUP_THRESHOLD_WINC: 'lots' })
    ).toThrow(/STORE_TURBO_TOPUP_THRESHOLD_WINC/);
    expect(() =>
      resolveTurboFundingEnv({
        STORE_TURBO_TOPUP_THRESHOLD_WINC: '1',
        STORE_TURBO_TOPUP_AMOUNT_ARIO: '-5',
      })
    ).toThrow(/STORE_TURBO_TOPUP_AMOUNT_ARIO/);
    expect(() =>
      resolveTurboFundingEnv({ STORE_TURBO_TOPUP_THRESHOLD_WINC: '-1' })
    ).toThrow(/positive/);
  });
});

// ---------------------------------------------------------------------------
// createTurboFundingMonitor — threshold and ceiling logic, no chain anywhere
// ---------------------------------------------------------------------------

interface StubClientState {
  winc: string;
  topUps: string[];
  failTopUp?: boolean;
  failBalance?: boolean;
}

function stubClient(state: StubClientState) {
  return {
    getBalance: vi.fn(async () => {
      if (state.failBalance) throw new Error('balance probe down');
      return { winc: state.winc };
    }),
    topUpWithTokens: vi.fn(async ({ tokenAmount }: { tokenAmount: string }) => {
      if (state.failTopUp) throw new Error('solana is down');
      state.topUps.push(tokenAmount);
      state.winc = '999999999999';
      return { id: 'stub-tx' };
    }),
  };
}

const silentLog = { info: vi.fn(), warn: vi.fn() };

function fundingConfig(overrides: Partial<TurboFundingEnvConfig>): TurboFundingEnvConfig {
  return {
    minIntervalMs: 3600_000,
    checkIntervalMs: 600_000,
    selfFundingEnabled: false,
    ...overrides,
  };
}

describe('createTurboFundingMonitor', () => {
  it('tops up below the threshold, in $ARIO base units', async () => {
    const state: StubClientState = { winc: '5', topUps: [] };
    const client = stubClient(state);
    const monitor = createTurboFundingMonitor({
      client,
      config: fundingConfig({
        thresholdWinc: 1000n,
        topUpAmountArio: 50,
        selfFundingEnabled: true,
      }),
      log: silentLog,
      now: () => 1_000_000,
    });
    await monitor.check();
    // 50 ARIO at 6 decimals
    expect(state.topUps).toEqual(['50000000']);
    const snap = monitor.snapshot();
    expect(snap.lastTopUp?.ok).toBe(true);
    expect(snap.lastTopUp?.amountArio).toBe(50);
    expect(snap.lastTopUp?.balanceAfterWinc).toBe('999999999999');
  });

  it('does not top up above the threshold', async () => {
    const state: StubClientState = { winc: '2000', topUps: [] };
    const client = stubClient(state);
    const monitor = createTurboFundingMonitor({
      client,
      config: fundingConfig({
        thresholdWinc: 1000n,
        topUpAmountArio: 50,
        selfFundingEnabled: true,
      }),
      log: silentLog,
    });
    await monitor.check();
    expect(state.topUps).toEqual([]);
  });

  it('clamps the attempt to the ceiling', async () => {
    const state: StubClientState = { winc: '5', topUps: [] };
    const monitor = createTurboFundingMonitor({
      client: stubClient(state),
      config: fundingConfig({
        thresholdWinc: 1000n,
        topUpAmountArio: 500,
        maxTopUpArio: 100,
        selfFundingEnabled: true,
      }),
      log: silentLog,
      now: () => 1_000_000,
    });
    await monitor.check();
    expect(state.topUps).toEqual(['100000000']); // 100 ARIO, not 500
  });

  it('suppresses a second attempt inside the interval, even after a failure', async () => {
    const state: StubClientState = { winc: '5', topUps: [], failTopUp: true };
    const client = stubClient(state);
    let clock = 1_000_000;
    const monitor = createTurboFundingMonitor({
      client,
      config: fundingConfig({
        thresholdWinc: 1000n,
        topUpAmountArio: 50,
        selfFundingEnabled: true,
        minIntervalMs: 60_000,
      }),
      log: silentLog,
      now: () => clock,
    });
    await monitor.check();
    expect(client.topUpWithTokens).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().lastTopUp?.ok).toBe(false);
    expect(monitor.snapshot().lastTopUp?.error).toMatch(/solana is down/);

    // 30s later: a failing loop must not become a spending loop.
    clock += 30_000;
    await monitor.check();
    expect(client.topUpWithTokens).toHaveBeenCalledTimes(1);

    // Past the interval: it may try again.
    clock += 31_000;
    state.failTopUp = false;
    await monitor.check();
    expect(client.topUpWithTokens).toHaveBeenCalledTimes(2);
  });

  it('a thrown top-up leaves the monitor serving (never throws)', async () => {
    const state: StubClientState = { winc: '5', topUps: [], failTopUp: true };
    const monitor = createTurboFundingMonitor({
      client: stubClient(state),
      config: fundingConfig({
        thresholdWinc: 1000n,
        topUpAmountArio: 50,
        selfFundingEnabled: true,
      }),
      log: silentLog,
      now: () => 1,
    });
    await expect(monitor.check()).resolves.toBeUndefined();
  });

  it('warn-only mode warns below the threshold and never spends', async () => {
    const state: StubClientState = { winc: '5', topUps: [] };
    const client = stubClient(state);
    const warn = vi.fn();
    const monitor = createTurboFundingMonitor({
      client,
      config: fundingConfig({ thresholdWinc: 1000n }),
      log: { info: vi.fn(), warn },
    });
    await monitor.check();
    expect(client.topUpWithTokens).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('low'));
  });

  it('a balance-probe failure is a warning, not a crash, and the snapshot says so', async () => {
    const state: StubClientState = { winc: '5', topUps: [], failBalance: true };
    const monitor = createTurboFundingMonitor({
      client: stubClient(state),
      config: fundingConfig({ thresholdWinc: 1000n }),
      log: silentLog,
    });
    await expect(monitor.check()).resolves.toBeUndefined();
    expect(monitor.snapshot().balanceWinc).toBeNull();
    expect(monitor.snapshot().canPayAboveFreeTier).toBe(false);
  });

  it('reports capacity in bytes an operator can act on', async () => {
    const state: StubClientState = { winc: '11600114792', topUps: [] }; // ~1 MiB at the measured rate
    const monitor = createTurboFundingMonitor({
      client: stubClient(state),
      config: fundingConfig({}),
      log: silentLog,
    });
    await monitor.check();
    const capacity = BigInt(monitor.snapshot().uploadCapacityBytes ?? '0');
    expect(capacity).toBeGreaterThan(1_000_000n);
    expect(capacity).toBeLessThan(1_100_000n);
    expect(wincToCapacityBytes(0n)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// createFundedUploadAdapter — refusal is behaviour, free tier is behaviour
// ---------------------------------------------------------------------------

const SMALL = Buffer.alloc(1024, 1);
const BIG = Buffer.alloc(TURBO_FREE_TIER_MAX_BYTES + 1, 1);

function innerAdapter() {
  return { upload: vi.fn(async () => ({ txId: 'inner-tx' })) };
}

describe('createFundedUploadAdapter', () => {
  it('passes free-tier-sized uploads through untouched, even unfunded at zero balance', async () => {
    // Story 15: losing funding degrades the service rather than stopping it.
    const inner = innerAdapter();
    const adapter = createFundedUploadAdapter(inner, { funded: false, log: silentLog });
    const result = await adapter.upload(SMALL, { a: 'b' });
    expect(result.txId).toBe('inner-tx');
    expect(inner.upload).toHaveBeenCalledWith(SMALL, { a: 'b' });
  });

  it('refuses an above-free-tier upload with no funding credential, by name', async () => {
    const inner = innerAdapter();
    const adapter = createFundedUploadAdapter(inner, { funded: false, log: silentLog });
    await expect(adapter.upload(BIG)).rejects.toThrow(/insufficient Turbo credits/);
    await expect(adapter.upload(BIG)).rejects.toThrow(/free tier/);
    expect(inner.upload).not.toHaveBeenCalled();
  });

  it('refuses at zero balance, naming the account to fund', async () => {
    const inner = innerAdapter();
    const adapter = createFundedUploadAdapter(inner, {
      funded: true,
      client: { getBalance: async () => ({ winc: '0' }) },
      accountAddress: 'XBk_fake_account',
      log: silentLog,
    });
    await expect(adapter.upload(BIG)).rejects.toThrow(/insufficient Turbo credits/);
    await expect(adapter.upload(BIG)).rejects.toThrow(/XBk_fake_account/);
    expect(inner.upload).not.toHaveBeenCalled();
  });

  it('refuses when the quoted cost exceeds the balance, with both numbers', async () => {
    const inner = innerAdapter();
    const adapter = createFundedUploadAdapter(inner, {
      funded: true,
      client: {
        getBalance: async () => ({ winc: '100' }),
        getUploadCosts: async () => [{ winc: '5000' }],
      },
      log: silentLog,
    });
    await expect(adapter.upload(BIG)).rejects.toThrow(/5000 winc/);
    await expect(adapter.upload(BIG)).rejects.toThrow(/100 winc/);
    expect(inner.upload).not.toHaveBeenCalled();
  });

  it('uploads when the balance covers the quote', async () => {
    const inner = innerAdapter();
    const adapter = createFundedUploadAdapter(inner, {
      funded: true,
      client: {
        getBalance: async () => ({ winc: '1000000000000' }),
        getUploadCosts: async () => [{ winc: '5000' }],
      },
      log: silentLog,
    });
    const result = await adapter.upload(BIG);
    expect(result.txId).toBe('inner-tx');
  });

  it('fails open when the pre-flight probe itself fails', async () => {
    // A pricing-API outage must not refuse uploads the balance would cover;
    // the real upload is the true answer.
    const inner = innerAdapter();
    const adapter = createFundedUploadAdapter(inner, {
      funded: true,
      client: {
        getBalance: async () => {
          throw new Error('payment service down');
        },
      },
      log: silentLog,
    });
    const result = await adapter.upload(BIG);
    expect(result.txId).toBe('inner-tx');
  });
});

// ---------------------------------------------------------------------------
// Secret non-disclosure — asserted statically, the way the repo already does
// for its deploy bundle: no log line in the funding path may interpolate the
// funding secret. The funding module never receives the key at all (it takes
// a constructed client), and the entrypoint must not log the variable.
// ---------------------------------------------------------------------------

describe('the funding secret is never logged', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));

  it('turbo-funding.ts never touches the key variable', () => {
    const source = readFileSync(`${repoRoot}src/turbo-funding.ts`, 'utf8');
    expect(source).not.toContain("env['STORE_TURBO_SOLANA_KEY']");
  });

  it('entrypoint-store.ts never interpolates the key into a log call', () => {
    const source = readFileSync(`${repoRoot}src/entrypoint-store.ts`, 'utf8');
    for (const line of source.split('\n')) {
      if (/console\.(log|warn|error)/.test(line)) {
        expect(line, `log line must not mention the raw key: ${line.trim()}`).not.toMatch(
          /\$\{(solanaKey|turboSolanaKey|secretB58)/
        );
      }
    }
  });
});
