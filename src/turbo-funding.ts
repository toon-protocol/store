/**
 * Turbo credit funding for the store (store#123).
 *
 * Three concerns, all resolved at the Turbo adapter factory seam and nowhere
 * else (the job handler keeps receiving an upload adapter and knows nothing
 * about how it was paid for):
 *
 *  - EXPLICIT NETWORK SELECTION. Which Solana network, and therefore which
 *    $ARIO mint, is a stated configuration decision. turbo-sdk picks its mint
 *    by testing the gateway URL for the substring "devnet"; that inference is
 *    treated as an implementation detail not to be relied on, so the stated
 *    network and the configured gateway are cross-checked at boot and a
 *    mismatch refuses to start. The mint for each network is pinned here.
 *
 *  - SELF-FUNDING (opt-in, bounded). A balance monitor reads the Turbo credit
 *    balance on an interval; below a configured threshold it buys more credits
 *    from the $ARIO the signing wallet holds, capped per attempt and
 *    rate-limited between attempts. A top-up failure is loud and non-fatal:
 *    the store keeps serving whatever the current balance and the free tier
 *    allow. With no top-up amount configured the monitor only warns, so an
 *    operator can run the node with no spend authority at all.
 *
 *  - REFUSING WHAT CANNOT BE PAID FOR. A wrapper adapter checks, before any
 *    bytes reach Turbo, that an above-free-tier upload is coverable by the
 *    current balance, and throws an error that names the reason (out of
 *    credit, or no funding credential) instead of letting the upload die
 *    inside Turbo as a generic failure. Known limit: the SDK's kind:5094
 *    handler maps every adapter throw to a fixed `T00 "Arweave upload
 *    failed"`, so the named reason reaches the operator's log and the health
 *    surface today, not the paying client; surfacing it to the client needs a
 *    change in @toon-protocol/sdk.
 *
 * Decision record (story 26): $ARIO self-funding supersedes #98's x402
 * per-upload path. #98 proved a different funding model fits behind the
 * ArweaveUploadAdapter seam without touching the job handler; that property
 * is preserved here, and is why no new seam exists. The x402 path itself is
 * not implemented: this is an ar.io app, and its storage is bought in ar.io's
 * own token.
 */

import type { ArweaveUploadAdapter } from '@toon-protocol/sdk';

// ---------------------------------------------------------------------------
// Network and mint selection
// ---------------------------------------------------------------------------

export type TurboSolanaNetwork = 'mainnet' | 'devnet';

/**
 * The $ARIO SPL mints, pinned per network (decision 23: stated, not inferred,
 * so a change in turbo-sdk's defaults cannot silently move which token this
 * node spends). Values match @ardrive/turbo-sdk's ARIOToken and @ar.io/sdk's
 * cluster constants as of turbo-sdk 1.40.x.
 */
export const ARIO_MINTS: Record<TurboSolanaNetwork, string> = {
  mainnet: 'DcNnMuFxwhgV4WY1HVSaSEgr92bv2b1vUvEKiNxWqHdF',
  devnet: '6vTw5CysRXQ4ybbHkDUiisHWVsBeMtUzYvJqs2iqHyaN',
};

export const ARIO_TOKEN_DECIMALS = 6;

export interface TurboSolanaNetworkConfig {
  network: TurboSolanaNetwork;
  /** RPC gateway to hand turbo-sdk; undefined lets the SDK use its production default. */
  gatewayUrl?: string;
  /** The $ARIO mint this configuration pays in, from ARIO_MINTS. */
  mint: string;
}

/**
 * Resolve STORE_TURBO_SOLANA_NETWORK / STORE_TURBO_SOLANA_GATEWAY.
 *
 * Defaults to mainnet: the store's uploads go to real Arweave and are
 * permanent, so mainnet is what an unconfigured box already meant (the SDK's
 * default gateway is a mainnet RPC). Devnet is the explicit opt-in, and it
 * REQUIRES a gateway URL containing "devnet", because that substring is how
 * turbo-sdk selects the devnet mint -- a stated devnet network with a mainnet
 * gateway would quietly spend the wrong token, which is exactly the mismatch
 * story 9 refuses to boot on.
 */
export function resolveTurboSolanaNetwork(
  env: NodeJS.ProcessEnv
): TurboSolanaNetworkConfig {
  const raw = env['STORE_TURBO_SOLANA_NETWORK']?.trim() || 'mainnet';
  if (raw !== 'mainnet' && raw !== 'devnet') {
    throw new Error(
      `STORE_TURBO_SOLANA_NETWORK must be 'mainnet' or 'devnet', got ${JSON.stringify(raw)}`
    );
  }
  const network = raw as TurboSolanaNetwork;
  const gatewayUrl = env['STORE_TURBO_SOLANA_GATEWAY']?.trim() || undefined;

  if (network === 'mainnet' && gatewayUrl?.includes('devnet')) {
    throw new Error(
      `STORE_TURBO_SOLANA_NETWORK is mainnet but STORE_TURBO_SOLANA_GATEWAY (${gatewayUrl}) ` +
        'contains "devnet" -- turbo-sdk would select the devnet $ARIO mint. ' +
        'Fix one of them; refusing to boot a node that would spend the wrong token.'
    );
  }
  if (network === 'devnet' && !gatewayUrl?.includes('devnet')) {
    throw new Error(
      'STORE_TURBO_SOLANA_NETWORK is devnet, which requires STORE_TURBO_SOLANA_GATEWAY ' +
        'to name a devnet RPC (a URL containing "devnet") -- turbo-sdk selects the mint ' +
        'from the gateway URL, and without this the node would spend mainnet $ARIO.'
    );
  }

  return {
    network,
    ...(gatewayUrl ? { gatewayUrl } : {}),
    mint: ARIO_MINTS[network],
  };
}

// ---------------------------------------------------------------------------
// Self-funding configuration
// ---------------------------------------------------------------------------

export interface TurboFundingEnvConfig {
  /** Balance level (winc) below which the monitor warns and, if enabled, tops up. */
  thresholdWinc?: bigint;
  /** $ARIO spent per top-up attempt (whole tokens; fractional allowed). Set = self-funding on. */
  topUpAmountArio?: number;
  /** Hard per-attempt ceiling; the attempt amount is clamped to it. */
  maxTopUpArio?: number;
  /** Minimum milliseconds between top-up ATTEMPTS (failed ones count -- story 6). */
  minIntervalMs: number;
  /** How often the monitor reads the balance. */
  checkIntervalMs: number;
  /** True when a top-up amount is configured. */
  selfFundingEnabled: boolean;
}

const DEFAULT_MIN_INTERVAL_SEC = 3600;
const DEFAULT_CHECK_INTERVAL_SEC = 600;

function parsePositiveNumber(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Resolve the self-funding envelope from the environment.
 *
 * Misconfiguration throws rather than degrades: a box that asked for
 * self-funding and got a silently-crippled monitor would run out of credits
 * overnight believing it could not (same posture as resolveArnsBuyEnv).
 *
 *   STORE_TURBO_TOPUP_THRESHOLD_WINC   trigger level; alone = warn-only
 *   STORE_TURBO_TOPUP_AMOUNT_ARIO      per-attempt spend; set = self-funding on
 *   STORE_TURBO_TOPUP_MAX_ARIO         per-attempt ceiling (default: the amount)
 *   STORE_TURBO_TOPUP_MIN_INTERVAL_SEC minimum seconds between attempts (default 3600)
 *   STORE_TURBO_BALANCE_CHECK_INTERVAL_SEC  balance poll interval (default 600)
 */
export function resolveTurboFundingEnv(
  env: NodeJS.ProcessEnv
): TurboFundingEnvConfig {
  const thresholdRaw = env['STORE_TURBO_TOPUP_THRESHOLD_WINC']?.trim();
  const amountRaw = env['STORE_TURBO_TOPUP_AMOUNT_ARIO']?.trim();
  const maxRaw = env['STORE_TURBO_TOPUP_MAX_ARIO']?.trim();
  const minIntervalRaw = env['STORE_TURBO_TOPUP_MIN_INTERVAL_SEC']?.trim();
  const checkIntervalRaw = env['STORE_TURBO_BALANCE_CHECK_INTERVAL_SEC']?.trim();

  let thresholdWinc: bigint | undefined;
  if (thresholdRaw) {
    try {
      thresholdWinc = BigInt(thresholdRaw);
    } catch {
      throw new Error(
        `STORE_TURBO_TOPUP_THRESHOLD_WINC must be an integer winc amount, got ${JSON.stringify(thresholdRaw)}`
      );
    }
    if (thresholdWinc <= 0n) {
      throw new Error('STORE_TURBO_TOPUP_THRESHOLD_WINC must be positive');
    }
  }

  const topUpAmountArio = amountRaw
    ? parsePositiveNumber('STORE_TURBO_TOPUP_AMOUNT_ARIO', amountRaw)
    : undefined;
  const maxTopUpArio = maxRaw
    ? parsePositiveNumber('STORE_TURBO_TOPUP_MAX_ARIO', maxRaw)
    : undefined;

  if (topUpAmountArio !== undefined && thresholdWinc === undefined) {
    throw new Error(
      'STORE_TURBO_TOPUP_AMOUNT_ARIO is set but STORE_TURBO_TOPUP_THRESHOLD_WINC is not. ' +
        'A top-up needs a trigger level; set the threshold or drop the amount.'
    );
  }
  if (maxTopUpArio !== undefined && topUpAmountArio === undefined) {
    throw new Error(
      'STORE_TURBO_TOPUP_MAX_ARIO is set but STORE_TURBO_TOPUP_AMOUNT_ARIO is not. ' +
        'The ceiling bounds an amount; set the amount or drop the ceiling.'
    );
  }

  const minIntervalSec = minIntervalRaw
    ? parsePositiveNumber('STORE_TURBO_TOPUP_MIN_INTERVAL_SEC', minIntervalRaw)
    : DEFAULT_MIN_INTERVAL_SEC;
  const checkIntervalSec = checkIntervalRaw
    ? parsePositiveNumber('STORE_TURBO_BALANCE_CHECK_INTERVAL_SEC', checkIntervalRaw)
    : DEFAULT_CHECK_INTERVAL_SEC;

  return {
    ...(thresholdWinc !== undefined ? { thresholdWinc } : {}),
    ...(topUpAmountArio !== undefined ? { topUpAmountArio } : {}),
    ...(maxTopUpArio !== undefined ? { maxTopUpArio } : {}),
    minIntervalMs: minIntervalSec * 1000,
    checkIntervalMs: checkIntervalSec * 1000,
    selfFundingEnabled: topUpAmountArio !== undefined,
  };
}

// ---------------------------------------------------------------------------
// The balance monitor
// ---------------------------------------------------------------------------

/** The slice of a Turbo client the monitor needs (duck-typed; stubbed in tests). */
export interface TurboBalanceClient {
  getBalance(): Promise<{ winc: string | bigint }>;
  topUpWithTokens?(params: { tokenAmount: string }): Promise<unknown>;
}

export interface TopUpRecord {
  at: string;
  amountArio: number;
  ok: boolean;
  error?: string;
  balanceAfterWinc?: string;
}

export interface TurboFundingSnapshot {
  /** Last balance read, string winc; null until the first successful read. */
  balanceWinc: string | null;
  balanceCheckedAt: string | null;
  /** Estimated upload capacity of the balance, in bytes. */
  uploadCapacityBytes: string | null;
  /** Whether an above-free-tier upload could currently be paid for. */
  canPayAboveFreeTier: boolean;
  selfFunding: boolean;
  thresholdWinc: string | null;
  lastTopUp: TopUpRecord | null;
}

export interface TurboFundingMonitor {
  /** One pass: read the balance, warn if low, top up if enabled and due. Never throws. */
  check(): Promise<void>;
  snapshot(): TurboFundingSnapshot;
  start(): void;
  stop(): void;
}

interface MonitorLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Measured winc price of a byte: 1 MiB = 11,600,114,792 winc (quoted by Turbo
 * as both 'arweave' and 'ario' -- the token is the currency, not the price;
 * store#123's investigation). Used only to express a balance as capacity, so
 * "runway" is a number an operator can act on.
 */
export const WINC_PER_BYTE_ESTIMATE = 11_063n;

export function wincToCapacityBytes(winc: bigint): bigint {
  if (winc <= 0n) return 0n;
  return winc / WINC_PER_BYTE_ESTIMATE;
}

export function createTurboFundingMonitor(options: {
  client: TurboBalanceClient;
  config: TurboFundingEnvConfig;
  log?: MonitorLogger;
  now?: () => number;
}): TurboFundingMonitor {
  const { client, config } = options;
  const log = options.log ?? {
    info: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
  };
  const now = options.now ?? Date.now;

  let balanceWinc: bigint | null = null;
  let balanceCheckedAt: number | null = null;
  let lastAttemptAt: number | null = null;
  let lastTopUp: TopUpRecord | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function readBalance(): Promise<bigint | null> {
    try {
      const raw = await client.getBalance();
      const winc = BigInt(typeof raw?.winc === 'bigint' ? raw.winc : String(raw?.winc ?? '0'));
      balanceWinc = winc;
      balanceCheckedAt = now();
      return winc;
    } catch (err) {
      // A balance-probe outage must not take the monitor down (decision 20's
      // spirit); the stale snapshot keeps its stale timestamp so an operator
      // can see the reads stopped.
      log.warn(
        `[store] Turbo balance probe failed: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  async function topUp(): Promise<void> {
    // Clamp to the ceiling (story 5); amount and ceiling are both boot-time
    // constants, so the clamp is deterministic per attempt.
    const amountArio = Math.min(
      config.topUpAmountArio ?? 0,
      config.maxTopUpArio ?? config.topUpAmountArio ?? 0
    );
    lastAttemptAt = now();
    const record: TopUpRecord = {
      at: new Date(lastAttemptAt).toISOString(),
      amountArio,
      ok: false,
    };
    log.info(
      `[store] Turbo balance is below threshold; buying credits with ${amountArio} $ARIO...`
    );
    try {
      if (typeof client.topUpWithTokens !== 'function') {
        throw new Error('this Turbo client cannot top up (no Solana signer)');
      }
      const tokenAmount = BigInt(
        Math.round(amountArio * 10 ** ARIO_TOKEN_DECIMALS)
      ).toString();
      await client.topUpWithTokens({ tokenAmount });
      const after = await readBalance();
      record.ok = true;
      if (after !== null) record.balanceAfterWinc = after.toString();
      // The audit line story 21 asks for: amount and resulting balance.
      log.info(
        `[store] Turbo top-up succeeded: spent ${amountArio} $ARIO, balance now ${after ?? 'unknown'} winc`
      );
    } catch (err) {
      // Loud and non-fatal (story 20): a Solana outage or an empty wallet
      // must not take the store down with it. The failed attempt still
      // occupies the interval slot, so a failing upload loop cannot become a
      // spending loop (story 6).
      record.error = err instanceof Error ? err.message : String(err);
      log.warn(`[store] Turbo top-up FAILED (store keeps serving): ${record.error}`);
    }
    lastTopUp = record;
  }

  async function check(): Promise<void> {
    const winc = await readBalance();
    if (winc === null) return;
    if (config.thresholdWinc === undefined || winc >= config.thresholdWinc) return;

    if (winc > 0n) {
      // Story 12: told BEFORE uploads start failing, not after.
      log.warn(
        `[store] Turbo balance is low: ${winc} winc (~${wincToCapacityBytes(winc)} bytes of upload) ` +
          `is below the ${config.thresholdWinc} winc threshold.`
      );
    } else {
      log.warn(
        '[store] Turbo balance is ZERO: uploads above the free tier will be refused until credits are added.'
      );
    }

    if (!config.selfFundingEnabled) return;
    if (lastAttemptAt !== null && now() - lastAttemptAt < config.minIntervalMs) {
      return; // an attempt (either outcome) already used this interval
    }
    await topUp();
  }

  function snapshot(): TurboFundingSnapshot {
    return {
      balanceWinc: balanceWinc?.toString() ?? null,
      balanceCheckedAt:
        balanceCheckedAt !== null ? new Date(balanceCheckedAt).toISOString() : null,
      uploadCapacityBytes:
        balanceWinc !== null ? wincToCapacityBytes(balanceWinc).toString() : null,
      canPayAboveFreeTier: balanceWinc !== null && balanceWinc > 0n,
      selfFunding: config.selfFundingEnabled,
      thresholdWinc: config.thresholdWinc?.toString() ?? null,
      lastTopUp,
    };
  }

  return {
    check,
    snapshot,
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        void check();
      }, config.checkIntervalMs);
      // Do not hold the process open for the monitor.
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The funded upload adapter
// ---------------------------------------------------------------------------

/**
 * Turbo's measured per-item free ceiling: 107,520 bytes (105 KiB), read live
 * from upload.ardrive.io's own descriptor -- NOT the round "100 KB" prose
 * suggests. Below it, any valid signer uploads at any balance, including zero
 * (verified on mainnet 2026-08-29), so losing funding degrades the store to
 * this tier rather than stopping it (story 15).
 */
export const TURBO_FREE_TIER_MAX_BYTES = 107_520;

/** The slice of a Turbo client the pre-flight cost check wants. */
export interface TurboCostClient {
  getBalance(): Promise<{ winc: string | bigint }>;
  getUploadCosts?(params: { bytes: number[] }): Promise<{ winc: string }[]>;
}

/**
 * Wrap an upload adapter so an above-free-tier upload the balance cannot
 * cover is refused BY NAME before any bytes reach Turbo, instead of failing
 * inside the Turbo request as a generic upload error. "Out of credit" and
 * "your blob is malformed" become different messages (story 3).
 *
 * Fail-open on probe errors: if the balance or cost read itself fails, the
 * upload proceeds and Turbo gives the true answer -- a pricing-API outage
 * must not refuse uploads the balance would have covered.
 */
export function createFundedUploadAdapter(
  inner: ArweaveUploadAdapter,
  options: {
    /** Whether a fundable credential is configured at all (false = free tier only). */
    funded: boolean;
    /** Client for fresh balance/cost reads; optional when funded is false. */
    client?: TurboCostClient;
    /** The Turbo account address, for the "fund this" half of the message. */
    accountAddress?: string;
    log?: MonitorLogger;
  }
): ArweaveUploadAdapter {
  const log = options.log ?? {
    info: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
  };
  return {
    async upload(data, tags) {
      if (data.length <= TURBO_FREE_TIER_MAX_BYTES) {
        return inner.upload(data, tags);
      }
      if (!options.funded) {
        throw new Error(
          `insufficient Turbo credits: upload is ${data.length} bytes, above the ` +
            `${TURBO_FREE_TIER_MAX_BYTES}-byte free tier, and no funding credential is ` +
            'configured (set STORE_TURBO_SOLANA_KEY). Refused before contacting Turbo.'
        );
      }
      if (options.client) {
        try {
          const raw = await options.client.getBalance();
          const balance = BigInt(
            typeof raw?.winc === 'bigint' ? raw.winc : String(raw?.winc ?? '0')
          );
          if (balance === 0n) {
            throw new Error(
              `insufficient Turbo credits: upload is ${data.length} bytes, above the ` +
                `${TURBO_FREE_TIER_MAX_BYTES}-byte free tier, and the Turbo balance is 0 winc. ` +
                `Fund account ${options.accountAddress ?? 'unknown'} at https://turbo.ardrive.io/`
            );
          }
          if (typeof options.client.getUploadCosts === 'function') {
            const costs = await options.client.getUploadCosts({ bytes: [data.length] });
            const cost = BigInt(costs?.[0]?.winc ?? '0');
            if (cost > balance) {
              throw new Error(
                `insufficient Turbo credits: this ${data.length}-byte upload costs ${cost} winc ` +
                  `but the balance is ${balance} winc. ` +
                  `Fund account ${options.accountAddress ?? 'unknown'} at https://turbo.ardrive.io/`
              );
            }
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('insufficient Turbo credits')) {
            throw err;
          }
          log.warn(
            `[store] Turbo pre-flight check failed (proceeding with the upload): ${err instanceof Error ? err.message : err}`
          );
        }
      }
      return inner.upload(data, tags);
    },
  };
}
