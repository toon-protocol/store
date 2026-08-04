/**
 * evm-gas-station — DVM relays a client-signed ERC-2771 meta-transaction
 * through a trusted forwarder and pays the gas (NIP-90 kind:5098; issue #68,
 * toon-meta#261 decision 9, companion to kind:5096's Solana gas station).
 *
 * NOT a co-signer: on EVM the client signs an EIP-712 `ForwardRequest`
 * (OpenZeppelin `ERC2771Forwarder`) naming itself as `from` and the
 * `TokenNetwork` as `to`; the DVM inspects it, simulates it, then submits its
 * OWN transaction calling the forwarder's `execute(request)` and pays the
 * gas. `TokenNetwork` resolves `_msgSender()` through the forwarder back to
 * the client's `from` address (ERC-2771), so the client stays the author and
 * authority of the call — the DVM contributes only gas.
 *
 * THE SECURITY PROPERTY (mirrors toon-meta#163 §1 / kind:5096, per issue #68
 * — "do not invent a second security posture for the EVM leg"): the relayer
 * decides whether to spend its own gas on someone else's signed call. All
 * four v1 mitigations are implemented here, none optional:
 *
 *  (a) DEDICATED relayer wallet, one per configured chain
 *      ({@link EvmChainConfig.relayerPrivateKey}). It holds native gas only,
 *      so the blast radius is that chain's float.
 *  (b) STATIC INSPECTION pre-broadcast ({@link inspectForwardRequest}): the
 *      request's `to` must be the configured `TokenNetwork` address, the
 *      request's `value` and `gas` must be within policy caps, and the
 *      `deadline` must be a sane near-future timestamp. Reasons:
 *      `target_not_whitelisted`, `value_cap_exceeded`, `gas_cap_exceeded`,
 *      `deadline_invalid`.
 *  (c) SIMULATION with a gas cap: `estimateGas` on the forwarder's
 *      `execute(request)` before signing/broadcasting the relayer's own
 *      transaction — catches anything static inspection can't (an
 *      underpriced/overpriced call, a target-side revert). An estimate that
 *      still exceeds the cap after inspection passed is the signature of a
 *      bypass attempt and is ALARM-logged. Reason: `gas_cap_exceeded`
 *      (post-simulation) / `simulation_failed` (revert).
 *  (d) FUNCTION-SELECTOR WHITELIST: only `TokenNetwork.setTotalDeposit`
 *      (deposit), `closeChannel` (close) and `settleChannel` (settle) —
 *      deliberately excluding `openChannel` and `claimFromChannel`, mirroring
 *      kind:5096's exclusion of `INITIALIZE_CHANNEL`/`CLAIM_FROM_CHANNEL`:
 *      opening a channel and claiming via a balance proof are not "an agent
 *      reclaiming its own collateral". Reason: `selector_not_whitelisted`.
 *
 * SIGNATURE/TRUST/NONCE validity is delegated to the forwarder's own
 * `verify(request)` view call rather than reimplemented here — it is the one
 * contract that actually knows its EIP-712 domain and the signer's current
 * nonce, so re-deriving that offline would be a second, driftable source of
 * truth for the same fact. Reason: `signature_invalid`.
 *
 * QUOTE → EXECUTE: the free quote phase returns `{ quoteId, relayer,
 * forwarder, tokenNetwork, forwarderNonce, maxGas, maxValueWei,
 * recommendedDeadline, expiresAt }`, bound to the caller's `from` address and
 * `chainId`. The client builds + EIP-712-signs the `ForwardRequestData`
 * off-chain and executes with the quoteId before expiry. `idempotencyKey`
 * dedupes retries: a key that already landed returns the original result, no
 * double-submit.
 *
 * CHAIN PORTABILITY IS THE POINT (issue #68): adding a new EVM chain is one
 * entry in {@link EvmGasStationConfig.chains} (chain id, RPC, forwarder +
 * TokenNetwork addresses, a funded relayer key) — no code change. See
 * `resolveEvmGasStationEnv` in `src/entrypoint-store.ts` for the
 * `EVM_GAS_STATION_CONFIG_JSON` env wiring.
 *
 * Failure results are MACHINE-READABLE (`status: 'failed', reason: …`) in the
 * kind:6098 result body, not transport rejects — a policy rejection is a
 * successfully processed job whose answer is "no".
 *
 * PAYMENT: payment-oblivious like every store handler — the connector in
 * front terminates the channel payment (RouteTermination).
 */

import { randomUUID } from 'node:crypto';
import type { NostrEvent } from 'nostr-tools/pure';
import { Contract, JsonRpcProvider, Wallet, getAddress, id as keccakId, isAddress } from 'ethers';
import type {
  StoreHandlerContext,
  StoreHandlerResponse,
} from './store-backend.js';

/** The NIP-90 job kind for an evm-gas-station (meta-tx relayer) job. */
export const EVM_GAS_STATION_KIND = 5098;

// ---------------------------------------------------------------------------
// ForwardRequestData (OpenZeppelin ERC2771Forwarder.ForwardRequestData)
// ---------------------------------------------------------------------------

/**
 * JSON-safe mirror of OZ's `ForwardRequestData` struct. `value`/`gas` are
 * decimal strings (a JS `number` cannot round-trip uint256 without loss);
 * `deadline` is a uint48 unix-seconds timestamp, safely a `number`.
 */
export interface ForwardRequestData {
  from: string;
  to: string;
  value: string;
  gas: string;
  deadline: number;
  data: string;
  signature: string;
}

/** The struct-tuple shape the forwarder ABI expects, in field order. */
export type ForwardRequestTuple = [
  from: string,
  to: string,
  value: string,
  gas: string,
  deadline: number,
  data: string,
  signature: string,
];

export function toForwardRequestTuple(r: ForwardRequestData): ForwardRequestTuple {
  return [r.from, r.to, r.value, r.gas, r.deadline, r.data, r.signature];
}

/**
 * Parse + shape-validate an untrusted JSON value into a {@link ForwardRequestData}.
 * Returns null (not a thrown error) on any mismatch — callers turn that into
 * the `malformed_request` failure reason.
 */
export function parseForwardRequest(raw: unknown): ForwardRequestData | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r['from'] !== 'string' ||
    typeof r['to'] !== 'string' ||
    typeof r['value'] !== 'string' ||
    typeof r['gas'] !== 'string' ||
    typeof r['deadline'] !== 'number' ||
    typeof r['data'] !== 'string' ||
    typeof r['signature'] !== 'string'
  ) {
    return null;
  }
  if (!isAddress(r['from']) || !isAddress(r['to'])) return null;
  if (!/^0x[0-9a-fA-F]*$/.test(r['data']) || !/^0x[0-9a-fA-F]+$/.test(r['signature'])) return null;
  if (!Number.isFinite(r['deadline']) || r['deadline'] < 0) return null;
  try {
    if (BigInt(r['value']) < 0n || BigInt(r['gas']) < 0n) return null;
  } catch {
    return null;
  }
  return {
    from: getAddress(r['from']),
    to: getAddress(r['to']),
    value: r['value'],
    gas: r['gas'],
    deadline: r['deadline'],
    data: r['data'],
    signature: r['signature'],
  };
}

// ---------------------------------------------------------------------------
// Function-selector whitelist (mitigation d)
// ---------------------------------------------------------------------------

/**
 * The three `TokenNetwork` operations an agent needs to fund or reclaim its
 * own channel without holding native gas — mirrors
 * `TOON_CHANNEL_DISCRIMINATORS` in `src/gas-station-handler.ts`.
 * `openChannel`/`claimFromChannel` are deliberately excluded (out of scope
 * for issue #68, same rationale as issue #67's Solana whitelist).
 */
export const TOKEN_NETWORK_FUNCTION_WHITELIST = {
  DEPOSIT: 'setTotalDeposit(bytes32,address,uint256)',
  CLOSE_CHANNEL: 'closeChannel(bytes32)',
  SETTLE_CHANNEL: 'settleChannel(bytes32)',
} as const;

function selectorOf(signature: string): string {
  return keccakId(signature).slice(0, 10).toLowerCase();
}

export const TOKEN_NETWORK_SELECTOR_WHITELIST: ReadonlySet<string> = new Set(
  Object.values(TOKEN_NETWORK_FUNCTION_WHITELIST).map(selectorOf)
);

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface EvmGasStationPolicy {
  /** 4-byte selectors permitted against the chain's TokenNetwork (mitigation d). */
  selectorWhitelist: ReadonlySet<string>;
  /** Max native `value` (wei) a forwarded call may carry — channel ops are non-payable. */
  maxValueWei: bigint;
  /** Max `gas` a forwarded call may request — the relayer's per-job blast radius. */
  maxGas: bigint;
  /** How far into the future a `deadline` may sit before it is refused, in seconds. */
  maxDeadlineSeconds: number;
}

export const DEFAULT_EVM_POLICY: EvmGasStationPolicy = {
  selectorWhitelist: TOKEN_NETWORK_SELECTOR_WHITELIST,
  maxValueWei: 0n,
  maxGas: 300_000n,
  maxDeadlineSeconds: 600, // 10 minutes
};

/** A single EVM chain the relayer supports — chain portability lives here. */
export interface EvmChainConfig {
  chainId: number;
  rpcUrl: string;
  forwarderAddress: string;
  tokenNetworkAddress: string;
  /** 0x-prefixed 32-byte secret key of this chain's DEDICATED relayer wallet. */
  relayerPrivateKey: string;
}

/** Machine-readable failure reasons (the kind:6098 `reason` vocabulary). */
export type EvmGasStationFailureReason =
  | 'malformed_request'
  | 'chain_not_supported'
  | 'target_not_whitelisted'
  | 'selector_not_whitelisted'
  | 'value_cap_exceeded'
  | 'gas_cap_exceeded'
  | 'deadline_invalid'
  | 'signature_invalid'
  | 'unknown_quote'
  | 'quote_expired'
  | 'request_mismatch'
  | 'simulation_failed'
  | 'float_exhausted'
  | 'confirmation_timeout'
  | 'broadcast_failed';

// ---------------------------------------------------------------------------
// Static inspection (mitigations b + d) — pure, heavily unit-tested
// ---------------------------------------------------------------------------

export interface EvmInspectionSuccess {
  ok: true;
}

export interface EvmInspectionFailure {
  ok: false;
  reason: EvmGasStationFailureReason;
  detail: string;
}

export type EvmInspectionResult = EvmInspectionSuccess | EvmInspectionFailure;

function fail(
  reason: EvmGasStationFailureReason,
  detail: string
): EvmInspectionFailure {
  return { ok: false, reason, detail };
}

/**
 * Statically inspect a parsed forward request against the policy BEFORE
 * simulating or signing anything (mitigations b + d). Rules:
 *
 *  1. `request.to` must be exactly the configured `TokenNetwork` address —
 *     the relayer never forwards to an arbitrary contract;
 *  2. the first 4 bytes of `request.data` must be one of
 *     {@link TOKEN_NETWORK_SELECTOR_WHITELIST} (deposit / close / settle);
 *  3. `request.value` must not exceed the policy cap (default 0 — channel
 *     ops move ERC-20, not native value);
 *  4. `request.gas` must not exceed the policy cap;
 *  5. `request.deadline` must not already be expired, and must not sit
 *     further in the future than the policy horizon (a request signed with
 *     an implausibly distant deadline is refused rather than trusted).
 */
export function inspectForwardRequest(
  request: ForwardRequestData,
  chain: EvmChainConfig,
  policy: EvmGasStationPolicy,
  now: () => number = Date.now
): EvmInspectionResult {
  if (getAddress(request.to) !== getAddress(chain.tokenNetworkAddress)) {
    return fail(
      'target_not_whitelisted',
      `request.to ${request.to} is not the configured TokenNetwork ${chain.tokenNetworkAddress}`
    );
  }

  const selector = request.data.slice(0, 10).toLowerCase();
  if (!policy.selectorWhitelist.has(selector)) {
    return fail(
      'selector_not_whitelisted',
      `selector ${selector} is not one of the permitted TokenNetwork operations (deposit / close / settle)`
    );
  }

  const value = BigInt(request.value);
  if (value > policy.maxValueWei) {
    return fail(
      'value_cap_exceeded',
      `requested value ${value} wei exceeds the cap ${policy.maxValueWei}`
    );
  }

  const gas = BigInt(request.gas);
  if (gas > policy.maxGas) {
    return fail(
      'gas_cap_exceeded',
      `requested gas ${gas} exceeds the cap ${policy.maxGas}`
    );
  }

  const nowSec = Math.floor(now() / 1000);
  if (request.deadline < nowSec) {
    return fail('deadline_invalid', `deadline ${request.deadline} is already in the past`);
  }
  if (request.deadline > nowSec + policy.maxDeadlineSeconds) {
    return fail(
      'deadline_invalid',
      `deadline ${request.deadline} is further than the ${policy.maxDeadlineSeconds}s policy horizon`
    );
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// RPC + signer seams (tests inject stubs — no live chain in tests, ever)
// ---------------------------------------------------------------------------

export interface EvmGasStationReceiptInfo {
  status: number;
  blockNumber: number;
  gasUsed: bigint;
  effectiveGasPriceWei: bigint | null;
}

export interface EvmGasStationChainDeps {
  relayerAddress: string;
  getForwarderNonce(from: string): Promise<bigint>;
  getRelayerBalance(): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  /** The forwarder's own `verify(request)` — authoritative for signature/trust/nonce. */
  verifyRequest(request: ForwardRequestData): Promise<boolean>;
  /** Simulates `execute(request)`; throws (with a revert-shaped message) on failure. */
  estimateExecuteGas(request: ForwardRequestData): Promise<bigint>;
  sendExecuteTransaction(request: ForwardRequestData, gasLimit: bigint): Promise<string>;
  /** null if not confirmed within timeoutMs. */
  waitForReceipt(
    txHash: string,
    timeoutMs: number,
    intervalMs: number
  ): Promise<EvmGasStationReceiptInfo | null>;
}

export type LoadEvmGasStationDeps = (
  chain: EvmChainConfig
) => Promise<EvmGasStationChainDeps>;

const FORWARDER_ABI = [
  'function execute((address from,address to,uint256 value,uint256 gas,uint48 deadline,bytes data,bytes signature) request) payable',
  'function verify((address from,address to,uint256 value,uint256 gas,uint48 deadline,bytes data,bytes signature) request) view returns (bool)',
  'function nonces(address owner) view returns (uint256)',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Default deps: ethers against the chain's configured RPC. */
export const defaultLoadEvmGasStationDeps: LoadEvmGasStationDeps = async (
  chain
) => {
  const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId);
  const wallet = new Wallet(chain.relayerPrivateKey, provider);
  const forwarder = new Contract(chain.forwarderAddress, FORWARDER_ABI, wallet);

  return {
    relayerAddress: wallet.address,
    getForwarderNonce: async (from) => BigInt(await forwarder['nonces'](from) as bigint),
    getRelayerBalance: async () => provider.getBalance(wallet.address),
    getGasPrice: async () => {
      const feeData = await provider.getFeeData();
      return feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
    },
    verifyRequest: async (r) =>
      Boolean(await forwarder['verify'](toForwardRequestTuple(r)) as boolean),
    estimateExecuteGas: async (r) =>
      BigInt(
        (await forwarder['execute'].estimateGas(toForwardRequestTuple(r), {
          value: r.value,
        })) as bigint
      ),
    sendExecuteTransaction: async (r, gasLimit) => {
      const tx = await forwarder['execute'](toForwardRequestTuple(r), {
        value: r.value,
        gasLimit,
      }) as { hash: string };
      return tx.hash;
    },
    waitForReceipt: async (txHash, timeoutMs, intervalMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt) {
          return {
            status: receipt.status ?? 0,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            effectiveGasPriceWei: receipt.gasPrice ?? null,
          };
        }
        await sleep(intervalMs);
      }
      return null;
    },
  };
};

// ---------------------------------------------------------------------------
// Param parsing
// ---------------------------------------------------------------------------

function paramTag(event: NostrEvent, key: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === 'param' && tag[1] === key) return tag[2];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** The kind:6098-shaped result carried (base64 JSON) in the job `data`. */
export interface EvmGasStationQuoteReceipt {
  job: 'evm-gas-station';
  phase: 'quote';
  status: 'ok';
  chainId: number;
  quoteId: string;
  /** The relayer's address, for operator/observer diagnostics only — the client never sends it funds. */
  relayer: string;
  forwarder: string;
  tokenNetwork: string;
  /** The forwarder's current `nonces(from)` — informational, saves the client an RPC round trip. */
  forwarderNonce: string;
  maxGas: string;
  maxValueWei: string;
  /** A deadline (unix seconds) the client MAY use when signing; not enforced beyond the policy horizon. */
  recommendedDeadline: number;
  /** ms epoch — the quote deadline. */
  expiresAt: number;
}

export interface EvmGasStationExecuteReceipt {
  job: 'evm-gas-station';
  phase: 'execute';
  status: 'ok';
  chainId: number;
  quoteId: string;
  idempotencyKey: string;
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  effectiveGasPriceWei: string | null;
  /** True when this result was replayed from the idempotency store. */
  replayed?: boolean;
}

export interface EvmGasStationFailureReceipt {
  job: 'evm-gas-station';
  phase: 'quote' | 'execute';
  status: 'failed';
  chainId?: number;
  reason: EvmGasStationFailureReason;
  detail: string;
}

export type EvmGasStationReceipt =
  | EvmGasStationQuoteReceipt
  | EvmGasStationExecuteReceipt
  | EvmGasStationFailureReceipt;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface EvmGasStationConfig {
  /** Chain-portable: one entry per supported EVM chain — adding a chain is a config entry, not new code. */
  chains: EvmChainConfig[];
  loadDeps?: LoadEvmGasStationDeps;
  /** Policy knob overrides (caps). */
  policy?: Partial<EvmGasStationPolicy>;
  /** Quote TTL in ms (default 120s — EVM confirmation is typically slower than Solana). */
  quoteTtlMs?: number;
  /** Clock seam for deadline tests. */
  now?: () => number;
  /** Confirmation polling seam (ms) — tests shrink these. */
  confirm?: { timeoutMs?: number; intervalMs?: number };
}

const DEFAULT_QUOTE_TTL_MS = 120_000;

interface QuoteRecord {
  quoteId: string;
  chainId: number;
  from: string;
  expiresAt: number;
}

function accept(receipt: EvmGasStationReceipt): StoreHandlerResponse {
  return {
    accept: true,
    data: Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64'),
  };
}

/**
 * Build the kind:5098 handler. Deps (provider + relayer signer) load lazily
 * per chain on first use and are cached; quotes and idempotency results are
 * kept in-memory (v1 — a store restart invalidates open quotes, which is
 * safe: clients re-quote, and a landed tx can only land once per forwarder
 * nonce).
 */
export function createEvmGasStationHandler(
  config: EvmGasStationConfig
): (ctx: StoreHandlerContext) => Promise<StoreHandlerResponse> {
  const now = config.now ?? Date.now;
  const quoteTtlMs = config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  const confirmTimeoutMs = config.confirm?.timeoutMs ?? 60_000;
  const confirmIntervalMs = config.confirm?.intervalMs ?? 3_000;
  const policy: EvmGasStationPolicy = { ...DEFAULT_EVM_POLICY, ...config.policy };
  const chainsById = new Map(config.chains.map((c) => [c.chainId, c]));

  const quotes = new Map<string, QuoteRecord>();
  const idempotency = new Map<string, EvmGasStationExecuteReceipt>();
  const depsCache = new Map<number, Promise<EvmGasStationChainDeps>>();

  /** Look up a configured chain by its raw (string) chainId param, or undefined if unknown/unparseable. */
  const lookupChain = (
    chainIdRaw: string
  ): { chainId: number; chain: EvmChainConfig } | undefined => {
    const chainId = Number(chainIdRaw);
    const chain = Number.isFinite(chainId) ? chainsById.get(chainId) : undefined;
    return chain ? { chainId, chain } : undefined;
  };

  const getDeps = (chain: EvmChainConfig): Promise<EvmGasStationChainDeps> => {
    let p = depsCache.get(chain.chainId);
    if (!p) {
      p = (config.loadDeps ?? defaultLoadEvmGasStationDeps)(chain).catch(
        (err: unknown) => {
          depsCache.delete(chain.chainId);
          throw err;
        }
      );
      depsCache.set(chain.chainId, p);
    }
    return p;
  };

  const failed = (
    phase: 'quote' | 'execute',
    chainId: number | undefined,
    reason: EvmGasStationFailureReason,
    detail: string
  ): StoreHandlerResponse => {
    console.warn(`[store] evm-gas-station ${phase} rejected: ${reason} — ${detail}`);
    return accept({
      job: 'evm-gas-station',
      phase,
      status: 'failed',
      ...(chainId !== undefined ? { chainId } : {}),
      reason,
      detail,
    });
  };

  async function runQuote(event: NostrEvent): Promise<StoreHandlerResponse> {
    const chainIdRaw = paramTag(event, 'chainId');
    const from = paramTag(event, 'from');
    if (!chainIdRaw || !from) {
      return failed(
        'quote',
        undefined,
        'malformed_request',
        "quote needs ['param','chainId'] and ['param','from']"
      );
    }
    const resolved = lookupChain(chainIdRaw);
    if (!resolved) {
      return failed(
        'quote',
        undefined,
        'chain_not_supported',
        `chain ${chainIdRaw} is not configured`
      );
    }
    const { chainId, chain } = resolved;
    if (!isAddress(from)) {
      return failed('quote', chainId, 'malformed_request', `'from' ${from} is not a valid address`);
    }

    const deps = await getDeps(chain);
    const [nonce, balance, gasPrice] = await Promise.all([
      deps.getForwarderNonce(from),
      deps.getRelayerBalance(),
      deps.getGasPrice(),
    ]);

    const requiredFloat = policy.maxGas * gasPrice * 2n;
    if (balance < requiredFloat) {
      return failed(
        'quote',
        chainId,
        'float_exhausted',
        `relayer float ${balance} wei cannot cover this job (needs ≥ ${requiredFloat} at current gas price ${gasPrice})`
      );
    }

    const record: QuoteRecord = {
      quoteId: randomUUID(),
      chainId,
      from: getAddress(from),
      expiresAt: now() + quoteTtlMs,
    };
    quotes.set(record.quoteId, record);

    return accept({
      job: 'evm-gas-station',
      phase: 'quote',
      status: 'ok',
      chainId,
      quoteId: record.quoteId,
      relayer: deps.relayerAddress,
      forwarder: chain.forwarderAddress,
      tokenNetwork: chain.tokenNetworkAddress,
      forwarderNonce: nonce.toString(),
      maxGas: policy.maxGas.toString(),
      maxValueWei: policy.maxValueWei.toString(),
      recommendedDeadline: Math.floor(now() / 1000) + Math.min(policy.maxDeadlineSeconds, Math.floor(quoteTtlMs / 1000) + 60),
      expiresAt: record.expiresAt,
    });
  }

  async function runExecute(event: NostrEvent): Promise<StoreHandlerResponse> {
    const chainIdRaw = paramTag(event, 'chainId');
    const requestB64 = paramTag(event, 'request');
    const quoteId = paramTag(event, 'quoteId');
    const idempotencyKey = paramTag(event, 'idempotencyKey');
    if (!chainIdRaw || !requestB64 || !quoteId || !idempotencyKey) {
      return failed(
        'execute',
        undefined,
        'malformed_request',
        "execute needs ['param','chainId'], ['param','request'], ['param','quoteId'] and ['param','idempotencyKey']"
      );
    }

    // Idempotent replay: a key that landed returns the original result.
    const replay = idempotency.get(idempotencyKey);
    if (replay) {
      return accept({ ...replay, replayed: true });
    }

    const resolved = lookupChain(chainIdRaw);
    if (!resolved) {
      return failed(
        'execute',
        undefined,
        'chain_not_supported',
        `chain ${chainIdRaw} is not configured`
      );
    }
    const { chainId, chain } = resolved;

    const quote = quotes.get(quoteId);
    if (!quote) {
      return failed('execute', chainId, 'unknown_quote', `no quote ${quoteId} — request a fresh quote first`);
    }
    if (now() > quote.expiresAt) {
      return failed('execute', chainId, 'quote_expired', `quote ${quoteId} expired at ${new Date(quote.expiresAt).toISOString()} — re-quote and re-sign`);
    }
    if (quote.chainId !== chainId) {
      return failed('execute', chainId, 'request_mismatch', `quote ${quoteId} was issued for chain ${quote.chainId}, not ${chainId}`);
    }

    let requestJson: unknown;
    try {
      requestJson = JSON.parse(Buffer.from(requestB64, 'base64').toString('utf8'));
    } catch (err) {
      return failed('execute', chainId, 'malformed_request', `'request' param is not valid base64 JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const request = parseForwardRequest(requestJson);
    if (!request) {
      return failed('execute', chainId, 'malformed_request', 'request does not match the ForwardRequestData shape (from,to,value,gas,deadline,data,signature)');
    }
    if (request.from !== quote.from) {
      return failed('execute', chainId, 'request_mismatch', `request.from ${request.from} does not match the quoted signer ${quote.from}`);
    }

    // ── Mitigations (b) + (d): the static gate ──────────────────────────────
    const inspection = inspectForwardRequest(request, chain, policy, now);
    if (!inspection.ok) {
      return failed('execute', chainId, inspection.reason, inspection.detail);
    }

    const deps = await getDeps(chain);

    // ── Signature/trust/nonce validity — authoritative on-chain check ───────
    const valid = await deps.verifyRequest(request);
    if (!valid) {
      return failed('execute', chainId, 'signature_invalid', 'forwarder.verify() rejected the request (bad signature, expired deadline, untrusted target, or stale nonce)');
    }

    // ── Mitigation (c): simulate + gas cap ───────────────────────────────────
    let estimatedGas: bigint;
    try {
      estimatedGas = await deps.estimateExecuteGas(request);
    } catch (err) {
      return failed('execute', chainId, 'simulation_failed', `simulation reverted: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (estimatedGas > policy.maxGas) {
      // Inspection passed but simulation shows an over-cap gas estimate: per
      // #163's precedent, this combination is the signature of an
      // inspection-bypass attempt.
      console.error(
        `[store] evm-gas-station ALARM: estimated gas ${estimatedGas} exceeds cap ${policy.maxGas} after static inspection passed (possible bypass attempt)`
      );
      return failed('execute', chainId, 'gas_cap_exceeded', `estimated gas ${estimatedGas} exceeds the cap ${policy.maxGas}`);
    }

    const [balance, gasPrice] = await Promise.all([
      deps.getRelayerBalance(),
      deps.getGasPrice(),
    ]);
    const estimatedCost = estimatedGas * gasPrice;
    if (balance < estimatedCost) {
      return failed('execute', chainId, 'float_exhausted', `relayer float ${balance} wei cannot cover the estimated cost ${estimatedCost}`);
    }

    // ── Sign + broadcast the relayer's own tx ────────────────────────────────
    const gasLimit = estimatedGas + estimatedGas / 5n; // 20% headroom
    let txHash: string;
    try {
      txHash = await deps.sendExecuteTransaction(request, gasLimit);
    } catch (err) {
      return failed('execute', chainId, 'broadcast_failed', `broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Confirm ───────────────────────────────────────────────────────────
    const receipt = await deps.waitForReceipt(txHash, confirmTimeoutMs, confirmIntervalMs);
    if (!receipt) {
      return failed('execute', chainId, 'confirmation_timeout', `transaction ${txHash} was broadcast but not confirmed within ${confirmTimeoutMs}ms — it may still land; retry with the same idempotencyKey`);
    }
    if (receipt.status !== 1) {
      return failed('execute', chainId, 'broadcast_failed', `transaction ${txHash} landed but FAILED on-chain (status ${receipt.status})`);
    }

    const result: EvmGasStationExecuteReceipt = {
      job: 'evm-gas-station',
      phase: 'execute',
      status: 'ok',
      chainId,
      quoteId,
      idempotencyKey,
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPriceWei: receipt.effectiveGasPriceWei === null ? null : receipt.effectiveGasPriceWei.toString(),
    };
    idempotency.set(idempotencyKey, result);
    quotes.delete(quoteId); // one execution per quote
    return accept(result);
  }

  return async (ctx) => {
    const event = ctx.decode();
    if (event.kind !== EVM_GAS_STATION_KIND) {
      return ctx.reject('F00', `evm-gas-station handler received kind:${event.kind}, expected kind:${EVM_GAS_STATION_KIND}`);
    }
    const phase = paramTag(event, 'phase');
    if (phase !== 'quote' && phase !== 'execute') {
      return ctx.reject('F00', "kind:5098 needs ['param','phase','quote'|'execute']");
    }
    try {
      return phase === 'quote' ? await runQuote(event) : await runExecute(event);
    } catch (err) {
      return ctx.reject('T00', `evm-gas-station ${phase} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
