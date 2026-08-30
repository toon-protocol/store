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
  estimateDataItemBytes,
  extractLandedFundTxId,
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

  it('redacts the gateway URL to its origin in the mismatch refusal', () => {
    // Helius/QuickNode-style URLs carry the API key in the path or query, and
    // the boot refusal lands in the operator's log.
    try {
      resolveTurboSolanaNetwork({
        STORE_TURBO_SOLANA_NETWORK: 'mainnet',
        STORE_TURBO_SOLANA_GATEWAY: 'https://devnet.helius-rpc.com/?api-key=SECRET-API-KEY',
      });
      expect.unreachable('must throw on the mainnet/devnet mismatch');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('SECRET-API-KEY');
      expect(message).toContain('https://devnet.helius-rpc.com');
    }
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
  destinations: (string | undefined)[];
  failTopUp?: boolean;
  failBalance?: boolean;
}

function stubClient(state: StubClientState) {
  return {
    getBalance: vi.fn(async () => {
      if (state.failBalance) throw new Error('balance probe down');
      return { winc: state.winc };
    }),
    topUpWithTokens: vi.fn(
      async ({
        tokenAmount,
        turboCreditDestinationAddress,
      }: {
        tokenAmount: string;
        turboCreditDestinationAddress?: string;
      }) => {
        if (state.failTopUp) throw new Error('solana is down');
        state.topUps.push(tokenAmount);
        state.destinations.push(turboCreditDestinationAddress);
        state.winc = '999999999999';
        return { id: 'stub-tx' };
      }
    ),
  };
}

const FAKE_ACCOUNT = 'XBk_fake_turbo_account';

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
    const state: StubClientState = { winc: '5', topUps: [], destinations: [] };
    const client = stubClient(state);
    const monitor = createTurboFundingMonitor({
      client,
      accountAddress: FAKE_ACCOUNT,
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
    const state: StubClientState = { winc: '2000', topUps: [], destinations: [] };
    const client = stubClient(state);
    const monitor = createTurboFundingMonitor({
      client,
      accountAddress: FAKE_ACCOUNT,
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
    const state: StubClientState = { winc: '5', topUps: [], destinations: [] };
    const monitor = createTurboFundingMonitor({
      client: stubClient(state),
      accountAddress: FAKE_ACCOUNT,
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
    const state: StubClientState = { winc: '5', topUps: [], destinations: [], failTopUp: true };
    const client = stubClient(state);
    let clock = 1_000_000;
    const monitor = createTurboFundingMonitor({
      client,
      accountAddress: FAKE_ACCOUNT,
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
    const state: StubClientState = { winc: '5', topUps: [], destinations: [], failTopUp: true };
    const monitor = createTurboFundingMonitor({
      client: stubClient(state),
      accountAddress: FAKE_ACCOUNT,
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
    const state: StubClientState = { winc: '5', topUps: [], destinations: [] };
    const client = stubClient(state);
    const warn = vi.fn();
    const monitor = createTurboFundingMonitor({
      client,
      accountAddress: FAKE_ACCOUNT,
      config: fundingConfig({ thresholdWinc: 1000n }),
      log: { info: vi.fn(), warn },
    });
    await monitor.check();
    expect(client.topUpWithTokens).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('low'));
  });

  it('a balance-probe failure is a warning, not a crash, and the snapshot says so', async () => {
    const state: StubClientState = { winc: '5', topUps: [], destinations: [], failBalance: true };
    const monitor = createTurboFundingMonitor({
      client: stubClient(state),
      accountAddress: FAKE_ACCOUNT,
      config: fundingConfig({ thresholdWinc: 1000n }),
      log: silentLog,
    });
    await expect(monitor.check()).resolves.toBeUndefined();
    expect(monitor.snapshot().balanceWinc).toBeNull();
    expect(monitor.snapshot().canPayAboveFreeTier).toBe(false);
  });

  it('names the credit destination on every transfer', async () => {
    // Mainnet demonstration 2026-08-30: without an explicit destination,
    // Turbo credits the account keyed by the raw Solana pubkey, and the
    // 'ario' client (which identifies as the sha256-shaped address) reads 0
    // forever. The winc is orphaned from this client's point of view.
    const state: StubClientState = { winc: '5', topUps: [], destinations: [] };
    const monitor = createTurboFundingMonitor({
      client: stubClient(state),
      accountAddress: FAKE_ACCOUNT,
      config: fundingConfig({
        thresholdWinc: 1000n,
        topUpAmountArio: 50,
        selfFundingEnabled: true,
      }),
      log: silentLog,
      now: () => 1_000_000,
    });
    await monitor.check();
    expect(state.destinations).toEqual([FAKE_ACCOUNT]);
  });

  it('refuses to transfer at all when the account address is unknown', async () => {
    const state: StubClientState = { winc: '5', topUps: [], destinations: [] };
    const client = stubClient(state);
    const monitor = createTurboFundingMonitor({
      client,
      // no accountAddress
      config: fundingConfig({
        thresholdWinc: 1000n,
        topUpAmountArio: 50,
        selfFundingEnabled: true,
      }),
      log: silentLog,
      now: () => 1_000_000,
    });
    await monitor.check();
    expect(client.topUpWithTokens).not.toHaveBeenCalled();
    expect(state.topUps).toEqual([]);
    expect(monitor.snapshot().lastTopUp?.ok).toBe(false);
    expect(monitor.snapshot().lastTopUp?.error).toMatch(/account address is unknown/);
  });

  it('a transfer that landed without credit is never re-sent; it is resubmitted until credited', async () => {
    // The HIGH from store#128's review: topUpWithTokens moves the tokens
    // FIRST and only then tells Turbo's payment API. If that second step
    // fails, retrying the transfer spends again for the same credit.
    const SDK_MESSAGE =
      "Failed to submit fund transaction! Save this Transaction ID and try again " +
      "with 'turbo.submitFundTransaction(id)': 5KtP9vGXbRTx3mJd4hQn8AeLBz2sYwCoUV7ufDkriE6M";
    let clock = 1_000_000;
    let paymentApiUp = false;
    let credited = false;
    const transfers: string[] = [];
    const submits: string[] = [];
    const client = {
      // The balance only rises once the payment API finally credits the tx.
      getBalance: vi.fn(async () => ({ winc: credited ? '999999999999' : '5' })),
      topUpWithTokens: vi.fn(async ({ tokenAmount }: { tokenAmount: string }) => {
        transfers.push(tokenAmount);
        throw new Error(SDK_MESSAGE); // tokens moved, credit did not
      }),
      submitFundTransaction: vi.fn(async ({ txId }: { txId: string }) => {
        submits.push(txId);
        if (!paymentApiUp) throw new Error('payment service still down');
        credited = true;
        return { id: txId };
      }),
    };
    const monitor = createTurboFundingMonitor({
      client,
      accountAddress: FAKE_ACCOUNT,
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
    expect(transfers).toHaveLength(1);
    expect(monitor.snapshot().pendingFundTxId).toBe(
      '5KtP9vGXbRTx3mJd4hQn8AeLBz2sYwCoUV7ufDkriE6M'
    );

    // Hours of ticks with the payment API down: submitFundTransaction is
    // retried every tick, and NO second transfer fires even though the
    // min-interval has long elapsed. The loop is bounded by outcome.
    for (let i = 0; i < 4; i++) {
      clock += 600_000;
      await monitor.check();
    }
    expect(transfers).toHaveLength(1);
    expect(submits.length).toBeGreaterThanOrEqual(4);

    // The API comes back: the pending tx clears and normal funding resumes.
    paymentApiUp = true;
    clock += 600_000;
    await monitor.check();
    const snap = monitor.snapshot();
    expect(snap.pendingFundTxId).toBeNull();
    expect(snap.lastTopUp?.ok).toBe(true);
    expect(snap.lastTopUp?.recoveredFundTxId).toBe(
      '5KtP9vGXbRTx3mJd4hQn8AeLBz2sYwCoUV7ufDkriE6M'
    );
  });

  it('holds the pending tx (and refuses transfers) when the client cannot resubmit', async () => {
    const SDK_MESSAGE =
      "Failed to submit fund transaction! Save this Transaction ID and try again " +
      "with 'turbo.submitFundTransaction(id)': 5KtP9vGXbRTx3mJd4hQn8AeLBz2sYwCoUV7ufDkriE6M";
    let clock = 1_000_000;
    const client = {
      getBalance: vi.fn(async () => ({ winc: '5' })),
      topUpWithTokens: vi.fn(async () => {
        throw new Error(SDK_MESSAGE);
      }),
      // no submitFundTransaction on this client
    };
    const monitor = createTurboFundingMonitor({
      client,
      accountAddress: FAKE_ACCOUNT,
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
    clock += 600_000;
    await monitor.check();
    expect(client.topUpWithTokens).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().pendingFundTxId).toBe(
      '5KtP9vGXbRTx3mJd4hQn8AeLBz2sYwCoUV7ufDkriE6M'
    );
  });

  it('prefers effectiveBalance over winc when the client reports it', async () => {
    // turbo-sdk's own on-demand logic spends against effectiveBalance; a
    // credit-share approval makes the two diverge.
    const client = {
      getBalance: vi.fn(async () => ({ winc: '999999999999', effectiveBalance: '5' })),
      topUpWithTokens: vi.fn(async () => ({ id: 'tx' })),
    };
    const monitor = createTurboFundingMonitor({
      client,
      accountAddress: FAKE_ACCOUNT,
      config: fundingConfig({
        thresholdWinc: 1000n,
        topUpAmountArio: 50,
        selfFundingEnabled: true,
      }),
      log: silentLog,
      now: () => 1_000_000,
    });
    await monitor.check();
    // Raw winc is huge, but the SPENDABLE balance is below threshold.
    expect(client.topUpWithTokens).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().balanceWinc).toBe('5');
  });

  it('canPayAboveFreeTier means covering the smallest above-free-tier upload, not 1 winc', async () => {
    const tiny = { getBalance: vi.fn(async () => ({ winc: '1' })) };
    const monitor = createTurboFundingMonitor({
      client: tiny,
      config: fundingConfig({}),
      log: silentLog,
    });
    await monitor.check();
    expect(monitor.snapshot().canPayAboveFreeTier).toBe(false);

    const funded = { getBalance: vi.fn(async () => ({ winc: '99999999999999' })) };
    const monitor2 = createTurboFundingMonitor({
      client: funded,
      config: fundingConfig({}),
      log: silentLog,
    });
    await monitor2.check();
    expect(monitor2.snapshot().canPayAboveFreeTier).toBe(true);
  });

  it('after stop(), an in-flight check does not spend', async () => {
    const state: StubClientState = { winc: '5', topUps: [], destinations: [] };
    const client = stubClient(state);
    const monitor = createTurboFundingMonitor({
      client,
      accountAddress: FAKE_ACCOUNT,
      config: fundingConfig({
        thresholdWinc: 1000n,
        topUpAmountArio: 50,
        selfFundingEnabled: true,
      }),
      log: silentLog,
      now: () => 1_000_000,
    });
    monitor.stop();
    await monitor.check();
    expect(client.topUpWithTokens).not.toHaveBeenCalled();
  });

  it('reports capacity in bytes an operator can act on', async () => {
    const state: StubClientState = { winc: '11600114792', topUps: [], destinations: [] }; // ~1 MiB at the measured rate
    const monitor = createTurboFundingMonitor({
      client: stubClient(state),
      accountAddress: FAKE_ACCOUNT,
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

  it('measures the free tier on the signed data item, not the payload', async () => {
    // The MEDIUM from store#128's review: Turbo applies the ceiling to the
    // signed ANS-104 item. A payload just under the ceiling overflows it once
    // the RSA envelope (~1 KiB) is added -- that must be refused by name, not
    // die inside Turbo as a generic T00.
    const boundaryPayload = Buffer.alloc(TURBO_FREE_TIER_MAX_BYTES - 500, 1);

    const inner = innerAdapter();
    const rsa = createFundedUploadAdapter(inner, {
      funded: false,
      signerKind: 'arweave-rsa',
      log: silentLog,
    });
    await expect(rsa.upload(boundaryPayload)).rejects.toThrow(/insufficient Turbo credits/);
    expect(inner.upload).not.toHaveBeenCalled();

    // The same payload under an ed25519 signer fits: its envelope is ~116 B.
    const inner2 = innerAdapter();
    const solana = createFundedUploadAdapter(inner2, {
      funded: false,
      signerKind: 'solana-ed25519',
      log: silentLog,
    });
    const result = await solana.upload(boundaryPayload);
    expect(result.txId).toBe('inner-tx');
  });

  it('estimateDataItemBytes counts envelope and tags', () => {
    expect(estimateDataItemBytes(1000, 'solana-ed25519')).toBe(1000 + 116);
    expect(estimateDataItemBytes(1000, 'arweave-rsa')).toBe(1000 + 1044);
    const withTags = estimateDataItemBytes(1000, 'solana-ed25519', {
      'Content-Type': 'application/octet-stream',
    });
    expect(withTags).toBeGreaterThan(1000 + 116 + 30);
    expect(withTags).toBeLessThan(1000 + 116 + 60);
  });

  it('extractLandedFundTxId parses exactly the SDK message shape', () => {
    expect(
      extractLandedFundTxId(
        "Failed to submit fund transaction! Save this Transaction ID and try again " +
          "with 'turbo.submitFundTransaction(id)': 5KtP9vGXbRTx3mJd4hQn8AeLBz2sYwCoUV7ufDkriE6M"
      )
    ).toBe('5KtP9vGXbRTx3mJd4hQn8AeLBz2sYwCoUV7ufDkriE6M');
    expect(extractLandedFundTxId('solana is down')).toBeUndefined();
    expect(extractLandedFundTxId('insufficient funds for transfer')).toBeUndefined();
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
    // Scan the WHOLE call expression, not just the line the `console.` sits
    // on: most of the entrypoint's log calls put their template literal on a
    // continuation line, which a per-line scan is blind to (store#128 review).
    const source = readFileSync(`${repoRoot}src/entrypoint-store.ts`, 'utf8');
    const calls = extractCallExpressions(source, /console\.(log|warn|error)\s*\(/g);
    expect(calls.length).toBeGreaterThan(10); // the scan must actually see them
    for (const call of calls) {
      expect(
        call,
        `log call must not mention the raw key: ${call.slice(0, 120)}`
      ).not.toMatch(/\$\{(solanaKey|turboSolanaKey|secretB58)/);
    }
  });
});

/**
 * Every span from a match of `open` to its balancing close paren. Parens
 * inside quotes/backticks are skipped so a ")" in a message cannot end the
 * span early; good enough for the entrypoint's actual log calls.
 */
function extractCallExpressions(source: string, open: RegExp): string[] {
  const spans: string[] = [];
  for (const match of source.matchAll(open)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote: string | null = null;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (quote !== null) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
    }
    spans.push(source.slice(start, i));
  }
  return spans;
}
