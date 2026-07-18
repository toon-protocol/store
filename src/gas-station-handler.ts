/**
 * gas-station — DVM co-signs and broadcasts client-authored Solana
 * transactions (NIP-90 kind:5096; toon-meta#163, companion to #162's
 * kind:5095 arns-buy).
 *
 * NOT a relay: on Solana the fee payer is named inside the signed message, so
 * the flow is Octane-style fee-payer-as-a-service — the client builds a
 * transaction with the DVM's advertised fee-payer address as `feePayer`,
 * partially signs with its own authority keys, and submits it; the DVM
 * inspects, simulates, co-signs as fee payer, broadcasts, and returns the
 * signature. The client stays the author and authority of every instruction;
 * the DVM contributes exactly the fee-payer signature and the lamports.
 *
 * THE SECURITY PROPERTY (toon-meta#163 §1): one Ed25519 signature covers the
 * whole message — co-signing authorizes every instruction. All four v1
 * mitigations are implemented here, none optional:
 *
 *  (a) DEDICATED fee-payer wallet (GAS_STATION_SOLANA_SECRET_KEY), separate
 *      from the kind:5095 ARIO-float wallet — enforced at boot (the
 *      entrypoint refuses identical keys). It holds working SOL only, so the
 *      blast radius is the SOL float by construction.
 *  (b) STATIC INSPECTION pre-sign ({@link inspectGasStationTransaction}):
 *      the fee-payer key must be the fee payer (static account 0) and appear
 *      exactly once; any instruction referencing it is rejected except the
 *      explicitly whitelisted RENT-PAYER slots — the MPL Core `CreateV1`
 *      payer slot, System `CreateAccount` funding, and a System `Transfer`
 *      FROM the fee payer bounded by the rent allowance (how a zero-SOL
 *      client's PDA rent gets funded; ar.io programs debit their PDA rent
 *      from the client-owned signer slot). Reason: `dvm_key_misplaced`.
 *  (c) SIMULATION with a balance-delta cap: `simulateTransaction` before
 *      signing; the fee-payer lamport delta must be ≤ the quoted
 *      `maxLamports`. Catches everything static inspection can't (CPI-driven
 *      debits, rent beyond quote). Reason: `delta_cap_exceeded`.
 *  (d) PROGRAM WHITELIST: ar.io ANT/ArNS/core registry programs, MPL Core,
 *      System, and ComputeBudget with a capped priority fee. Reasons:
 *      `program_not_whitelisted`, `priority_fee_exceeded`.
 *
 * QUOTE → EXECUTE: the free quote phase returns `{ quoteId, feePayer,
 * maxLamports, recentBlockhash, expiresAt }` — quote TTL and blockhash
 * validity merge into ONE deadline (~60s; durable nonces are out of scope in
 * v1). The client builds + partial-signs against the quoted blockhash and
 * executes with the quoteId before expiry. `idempotencyKey` dedupes retries:
 * a key that already landed returns the original result, no double-broadcast.
 *
 * Failure results are MACHINE-READABLE (`status: 'failed', reason: …`) in the
 * kind:6096 result body, not transport rejects — a policy rejection is a
 * successfully processed job whose answer is "no".
 *
 * PAYMENT: payment-oblivious like every store handler — the connector in
 * front terminates the channel payment (RouteTermination).
 */

import { randomUUID } from 'node:crypto';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  address as toAddress,
  createKeyPairFromBytes,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  signBytes,
} from '@solana/kit';
import type {
  StoreHandlerContext,
  StoreHandlerResponse,
} from './store-backend.js';
import type { ArnsNetwork } from './arns-buy-handler.js';

/** The NIP-90 job kind for a gas-station (fee-payer-as-a-service) job. */
export const GAS_STATION_KIND = 5096;

// ---------------------------------------------------------------------------
// Well-known program addresses
// ---------------------------------------------------------------------------

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM =
  'ComputeBudget111111111111111111111111111111';
/** Metaplex Core (canonical program id, same on devnet + mainnet). */
export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

/**
 * Default quote TTL — merged with Solana blockhash validity (~60–90s), one
 * deadline. Configurable via {@link GasStationConfig.quoteTtlMs} for
 * operators/e2e whose client ceremony (e.g. a multi-step channel-paid job that
 * signs an o1js Mina claim per submission) takes longer than the default
 * between quote and execute — bounded in practice by how long the quoted
 * Solana blockhash stays valid.
 */
export const QUOTE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** The v1 gate ({@link inspectGasStationTransaction}) parameters. */
export interface GasStationPolicy {
  /** The DVM's advertised fee-payer address (base58). */
  feePayer: string;
  /** Program ids allowed to appear in the transaction (mitigation d). */
  programWhitelist: ReadonlySet<string>;
  /** Max priority fee (ComputeBudget price × limit) in lamports. */
  priorityFeeCapLamports: bigint;
  /**
   * Max TOTAL lamports the fee payer may fund via the whitelisted rent-payer
   * System instructions (Transfer-from-fee-payer / CreateAccount). The
   * simulation delta cap (mitigation c) remains the hard bound on top.
   */
  rentAllowanceLamports: bigint;
  /** `maxLamports` for a quote submitted without a draft transaction. */
  defaultMaxLamports: bigint;
  /** Absolute per-job ceiling — quotes above this are refused. */
  maxLamportsCeiling: bigint;
}

export const DEFAULT_POLICY: Omit<GasStationPolicy, 'feePayer' | 'programWhitelist'> = {
  priorityFeeCapLamports: 200_000n, // 0.0002 SOL of priority fee
  rentAllowanceLamports: 10_000_000n, // 0.01 SOL of rent funding
  defaultMaxLamports: 1_000_000n, // fees + priority, no rent
  maxLamportsCeiling: 20_000_000n, // 0.02 SOL — the per-job blast radius
};

/** Machine-readable failure reasons (the kind:6096 `reason` vocabulary). */
export type GasStationFailureReason =
  | 'malformed_transaction'
  | 'fee_payer_mismatch'
  | 'dvm_key_misplaced'
  | 'program_not_whitelisted'
  | 'priority_fee_exceeded'
  | 'missing_client_signature'
  | 'unknown_quote'
  | 'quote_expired'
  | 'blockhash_mismatch'
  | 'blockhash_expired'
  | 'simulation_failed'
  | 'delta_cap_exceeded'
  | 'float_exhausted'
  | 'quote_refused'
  | 'confirmation_timeout'
  | 'broadcast_failed';

// ---------------------------------------------------------------------------
// Static inspection (mitigation b + d) — pure, heavily unit-tested
// ---------------------------------------------------------------------------

export interface GasInspectionSuccess {
  ok: true;
  messageBytes: Uint8Array;
  /** Signature map (address → 64-byte sig or null) from the wire tx. */
  signatures: Record<string, Uint8Array | null>;
  staticAccounts: string[];
  /** The message's recent-blockhash lifetime token (base58). */
  recentBlockhash: string;
}

export interface GasInspectionFailure {
  ok: false;
  reason: GasStationFailureReason;
  detail: string;
}

export type GasInspectionResult = GasInspectionSuccess | GasInspectionFailure;

function fail(
  reason: GasStationFailureReason,
  detail: string
): GasInspectionFailure {
  return { ok: false, reason, detail };
}

/** Read a LE u32/u64 out of instruction data (bounds-checked). */
function readU32LE(data: Uint8Array, offset: number): number | null {
  if (data.length < offset + 4) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
    offset,
    true
  );
}
function readU64LE(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null;
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength
  ).getBigUint64(offset, true);
}

/**
 * Statically inspect a partially-signed wire transaction against the policy
 * BEFORE anything is signed (mitigations b + d). Rules:
 *
 *  1. static account 0 (the fee payer) must be the gas wallet, and the gas
 *     wallet must appear exactly once in the account list;
 *  2. every instruction's program must be whitelisted;
 *  3. an instruction may reference account 0 ONLY in the whitelisted
 *     rent-payer shapes:
 *       - System `CreateAccount`(0) / `CreateAccountWithSeed`(3) with the
 *         fee payer as the funder (first account) — lamports counted against
 *         the rent allowance;
 *       - System `Transfer`(2) FROM the fee payer — lamports counted against
 *         the rent allowance (this is how a zero-SOL client's PDA rent is
 *         funded; the simulation delta cap still bounds the total). A
 *         Transfer TO the fee payer is always fine;
 *       - MPL Core `CreateV1`(discriminator 0) with the fee payer in the
 *         PAYER slot (instruction account index 3) only;
 *     anything else — including ANY ar.io-program slot — is
 *     `dvm_key_misplaced` (the gas wallet must never be an ar.io authority,
 *     owner, or caller);
 *  4. ComputeBudget priority fee (unit price × unit limit) must be under the
 *     cap;
 *  5. every required signer except the fee payer must already carry a
 *     signature (`missing_client_signature`).
 */
export function inspectGasStationTransaction(
  wireBase64: string,
  policy: GasStationPolicy
): GasInspectionResult {
  let messageBytes: Uint8Array;
  let signatures: Record<string, Uint8Array | null>;
  try {
    const wire = Uint8Array.from(Buffer.from(wireBase64, 'base64'));
    const tx = getTransactionDecoder().decode(wire);
    messageBytes = tx.messageBytes as unknown as Uint8Array;
    signatures = tx.signatures as unknown as Record<string, Uint8Array | null>;
  } catch (err) {
    return fail(
      'malformed_transaction',
      `could not decode wire transaction: ${err instanceof Error ? err.message : err}`
    );
  }

  let compiled: {
    staticAccounts: readonly string[];
    lifetimeToken: string;
    instructions: readonly {
      programAddressIndex: number;
      accountIndices?: readonly number[];
      data?: Uint8Array;
    }[];
  };
  try {
    compiled = getCompiledTransactionMessageDecoder().decode(
      messageBytes
    ) as unknown as typeof compiled;
  } catch (err) {
    return fail(
      'malformed_transaction',
      `could not decode compiled message: ${err instanceof Error ? err.message : err}`
    );
  }

  const accounts = compiled.staticAccounts.map(String);

  // ── Rule 1: fee-payer position + uniqueness ──────────────────────────────
  if (accounts.length === 0 || accounts[0] !== policy.feePayer) {
    return fail(
      'fee_payer_mismatch',
      `fee payer is ${accounts[0] ?? '(none)'}, expected the gas wallet ${policy.feePayer}`
    );
  }
  const occurrences = accounts.filter((a) => a === policy.feePayer).length;
  if (occurrences !== 1) {
    return fail(
      'dvm_key_misplaced',
      `the gas wallet appears ${occurrences} times in the account list — it may only be the fee payer`
    );
  }

  // ── Rules 2–4: per-instruction checks ────────────────────────────────────
  let rentFunded = 0n;
  let cuLimit: bigint | null = null;
  let cuPriceMicroLamports: bigint | null = null;

  for (const [i, ix] of compiled.instructions.entries()) {
    const program = accounts[ix.programAddressIndex];
    if (program === undefined) {
      return fail('malformed_transaction', `instruction ${i} has an out-of-range program index`);
    }
    if (!policy.programWhitelist.has(program)) {
      return fail(
        'program_not_whitelisted',
        `instruction ${i} invokes ${program}, which is not on the v1 whitelist`
      );
    }
    const indices = ix.accountIndices ?? [];
    const data = ix.data ?? new Uint8Array(0);
    const referencesFeePayer = indices.includes(0);

    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (referencesFeePayer) {
        return fail('dvm_key_misplaced', `instruction ${i}: ComputeBudget must not reference the gas wallet`);
      }
      const disc = data[0];
      if (disc === 2) {
        const v = readU32LE(data, 1);
        if (v !== null) cuLimit = BigInt(v);
      } else if (disc === 3) {
        const v = readU64LE(data, 1);
        if (v !== null) cuPriceMicroLamports = v;
      }
      continue;
    }

    if (!referencesFeePayer) continue;

    if (program === SYSTEM_PROGRAM) {
      const disc = readU32LE(data, 0);
      if (disc === 2) {
        // Transfer: accounts [source, destination]
        const source = indices[0];
        const destination = indices[1];
        if (destination === 0 && source !== 0) continue; // paying the DVM — fine
        if (source !== 0) {
          return fail('dvm_key_misplaced', `instruction ${i}: System transfer references the gas wallet outside the source/destination slots`);
        }
        const lamports = readU64LE(data, 4);
        if (lamports === null) {
          return fail('malformed_transaction', `instruction ${i}: truncated System transfer`);
        }
        rentFunded += lamports;
      } else if (disc === 0 || disc === 3) {
        // CreateAccount / CreateAccountWithSeed: funder is account 0
        if (indices[0] !== 0 || indices.slice(1).includes(0)) {
          return fail('dvm_key_misplaced', `instruction ${i}: System create-account references the gas wallet outside the funder slot`);
        }
        const lamports = readU64LE(data, 4);
        if (lamports === null) {
          return fail('malformed_transaction', `instruction ${i}: truncated System create-account`);
        }
        rentFunded += lamports;
      } else {
        return fail('dvm_key_misplaced', `instruction ${i}: System instruction ${disc ?? '(unknown)'} may not reference the gas wallet`);
      }
      if (rentFunded > policy.rentAllowanceLamports) {
        return fail('dvm_key_misplaced', `rent funding from the gas wallet (${rentFunded} lamports) exceeds the allowance (${policy.rentAllowanceLamports})`);
      }
      continue;
    }

    if (program === MPL_CORE_PROGRAM) {
      // CreateV1 (discriminator 0) accounts:
      // [asset, collection, authority, payer, owner, updateAuthority, systemProgram, logWrapper]
      const disc = data[0];
      const payerSlotOnly =
        disc === 0 &&
        indices[3] === 0 &&
        indices.filter((idx) => idx === 0).length === 1;
      if (!payerSlotOnly) {
        return fail('dvm_key_misplaced', `instruction ${i}: the gas wallet may appear in MPL Core only as the CreateV1 payer slot`);
      }
      continue;
    }

    // ar.io programs (and any other whitelisted program): the gas wallet has
    // no legitimate slot at all — it must never be a caller/owner/authority.
    return fail('dvm_key_misplaced', `instruction ${i}: the gas wallet may not appear in a ${program} instruction`);
  }

  // ── Rule 4: priority-fee cap ─────────────────────────────────────────────
  if (cuPriceMicroLamports !== null && cuPriceMicroLamports > 0n) {
    const effectiveLimit = cuLimit ?? 1_400_000n; // worst-case tx budget
    const priorityLamports =
      (cuPriceMicroLamports * effectiveLimit + 999_999n) / 1_000_000n;
    if (priorityLamports > policy.priorityFeeCapLamports) {
      return fail(
        'priority_fee_exceeded',
        `priority fee ${priorityLamports} lamports (price ${cuPriceMicroLamports} µlam × limit ${effectiveLimit}) exceeds the cap ${policy.priorityFeeCapLamports}`
      );
    }
  }

  // ── Rule 5: all client signatures present ────────────────────────────────
  for (const [addr, sig] of Object.entries(signatures)) {
    if (addr === policy.feePayer) continue;
    if (sig === null || sig === undefined) {
      return fail('missing_client_signature', `required signer ${addr} has not signed — partial-sign before submitting`);
    }
  }

  return {
    ok: true,
    messageBytes,
    signatures,
    staticAccounts: accounts,
    recentBlockhash: String(compiled.lifetimeToken),
  };
}

// ---------------------------------------------------------------------------
// RPC + signer seams (tests inject stubs — no live cluster in tests, ever)
// ---------------------------------------------------------------------------

export interface GasStationRpc {
  getLatestBlockhash(): Promise<{ blockhash: string }>;
  getBalance(address: string): Promise<bigint>;
  /**
   * Simulate the (possibly not-yet-fully-signed) wire tx with signature
   * verification off, returning the fee payer's post-execution lamports.
   */
  simulateTransaction(
    wireBase64: string,
    opts: { replaceRecentBlockhash: boolean; feePayer: string }
  ): Promise<{
    err: unknown;
    logs: readonly string[];
    feePayerPostLamports: bigint | null;
  }>;
  sendTransaction(wireBase64: string): Promise<string>;
  /** null until the signature reaches at least 'confirmed'. */
  getSignatureStatus(sig: string): Promise<{
    confirmationStatus: string | null;
    err: unknown;
    slot: bigint | null;
  } | null>;
  /** Landed-transaction fee in lamports (best-effort; null if unknown). */
  getTransactionFee(sig: string): Promise<bigint | null>;
}

export interface GasStationSignerSeam {
  address: string;
  sign(messageBytes: Uint8Array): Promise<Uint8Array>;
}

export interface GasStationDeps {
  rpc: GasStationRpc;
  signer: GasStationSignerSeam;
  /** ar.io program ids for the configured network (whitelist input). */
  arioProgramIds: string[];
}

export type LoadGasStationDeps = (options: {
  network: ArnsNetwork;
  solanaSecretKey: Uint8Array;
}) => Promise<GasStationDeps>;

/** Default deps: @solana/kit rpc against the network's cluster. */
export const defaultLoadGasStationDeps: LoadGasStationDeps = async (
  options
) => {
  const sdkSpecifier = '@ar.io/sdk' as string;
  const mod = (await import(sdkSpecifier)) as {
    DEVNET_RPC_URL?: string;
    DEFAULT_SOLANA_RPC_URL?: string;
    DEVNET_PROGRAM_IDS?: Record<string, string>;
    ARIO_ANT_PROGRAM_ID?: unknown;
    ARIO_ARNS_PROGRAM_ID?: unknown;
    ARIO_CORE_PROGRAM_ID?: unknown;
  };
  const rpcUrl =
    options.network === 'devnet'
      ? (mod.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com')
      : (mod.DEFAULT_SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com');
  const arioProgramIds =
    options.network === 'devnet'
      ? Object.values(mod.DEVNET_PROGRAM_IDS ?? {})
      : ([mod.ARIO_ANT_PROGRAM_ID, mod.ARIO_ARNS_PROGRAM_ID, mod.ARIO_CORE_PROGRAM_ID]
          .filter((x): x is string => typeof x === 'string'));

  const rpc = createSolanaRpc(rpcUrl);
  const keyPair = await createKeyPairFromBytes(options.solanaSecretKey);
  const { getAddressFromPublicKey } = await import('@solana/kit');
  const addr = await getAddressFromPublicKey(keyPair.publicKey);

  return {
    arioProgramIds,
    signer: {
      address: String(addr),
      sign: async (messageBytes) =>
        (await signBytes(
          keyPair.privateKey,
          messageBytes as Parameters<typeof signBytes>[1]
        )) as unknown as Uint8Array,
    },
    rpc: {
      getLatestBlockhash: async () => {
        const { value } = await rpc.getLatestBlockhash().send();
        return { blockhash: String(value.blockhash) };
      },
      getBalance: async (a) => {
        const { value } = await rpc.getBalance(toAddress(a)).send();
        return BigInt(value);
      },
      simulateTransaction: async (wireBase64, opts) => {
        const { value } = await rpc
          .simulateTransaction(
            wireBase64 as Parameters<typeof rpc.simulateTransaction>[0],
            {
              encoding: 'base64',
              sigVerify: false,
              replaceRecentBlockhash: opts.replaceRecentBlockhash,
              accounts: {
                encoding: 'base64',
                addresses: [toAddress(opts.feePayer)],
              },
            } as never
          )
          .send();
        const account = value.accounts?.[0] ?? null;
        return {
          err: value.err,
          logs: value.logs ?? [],
          feePayerPostLamports:
            account === null ? null : BigInt(account.lamports),
        };
      },
      sendTransaction: async (wireBase64) =>
        String(
          await rpc
            .sendTransaction(
              wireBase64 as Parameters<typeof rpc.sendTransaction>[0],
              { encoding: 'base64', preflightCommitment: 'confirmed' }
            )
            .send()
        ),
      getSignatureStatus: async (sig) => {
        const { value } = await rpc
          .getSignatureStatuses([sig as never], {
            searchTransactionHistory: true,
          })
          .send();
        const status = value[0];
        if (!status) return null;
        return {
          confirmationStatus: status.confirmationStatus ?? null,
          err: status.err,
          slot: status.slot === undefined ? null : BigInt(status.slot),
        };
      },
      getTransactionFee: async (sig) => {
        try {
          const tx = await rpc
            .getTransaction(sig as never, {
              maxSupportedTransactionVersion: 0,
              encoding: 'json',
            })
            .send();
          const fee = tx?.meta?.fee;
          return fee === undefined ? null : BigInt(fee);
        } catch {
          return null;
        }
      },
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

/** The kind:6096-shaped result carried (base64 JSON) in the job `data`. */
export interface GasStationQuoteReceipt {
  job: 'gas-station';
  phase: 'quote';
  status: 'ok';
  network: ArnsNetwork;
  quoteId: string;
  /** The address the client must set as its transaction feePayer. */
  feePayer: string;
  maxLamports: string;
  recentBlockhash: string;
  /** ms epoch — the merged quote/blockhash deadline. */
  expiresAt: number;
}

export interface GasStationExecuteReceipt {
  job: 'gas-station';
  phase: 'execute';
  status: 'ok';
  network: ArnsNetwork;
  quoteId: string;
  idempotencyKey: string;
  signature: string;
  slot: string | null;
  feeLamportsActual: string | null;
  /** True when this result was replayed from the idempotency store. */
  replayed?: boolean;
}

export interface GasStationFailureReceipt {
  job: 'gas-station';
  phase: 'quote' | 'execute';
  status: 'failed';
  network: ArnsNetwork;
  reason: GasStationFailureReason;
  detail: string;
}

export type GasStationReceipt =
  | GasStationQuoteReceipt
  | GasStationExecuteReceipt
  | GasStationFailureReceipt;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface GasStationConfig {
  network: ArnsNetwork;
  /** 64-byte Ed25519 keypair of the DEDICATED fee-payer wallet. */
  solanaSecretKey: Uint8Array;
  loadDeps?: LoadGasStationDeps;
  /** Policy knob overrides (caps, allowances). */
  policy?: Partial<Omit<GasStationPolicy, 'feePayer' | 'programWhitelist'>>;
  /**
   * Merged quote/blockhash deadline in ms (default {@link QUOTE_TTL_MS}).
   * Raise it for a slow client ceremony; keep it under how long the quoted
   * Solana blockhash stays valid or execute rejects with `blockhash_expired`.
   */
  quoteTtlMs?: number;
  /** Clock seam for deadline tests. */
  now?: () => number;
  /** Confirmation polling seam (ms) — tests shrink these. */
  confirm?: { timeoutMs?: number; intervalMs?: number };
}

interface QuoteRecord {
  quoteId: string;
  maxLamports: bigint;
  blockhash: string;
  expiresAt: number;
}

function accept(receipt: GasStationReceipt): StoreHandlerResponse {
  return {
    accept: true,
    data: Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64'),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the kind:5096 handler. Deps (rpc + fee-payer signer) load lazily on
 * the first job and are cached; quotes and idempotency results are kept
 * in-memory (v1 — a store restart invalidates open quotes, which is safe:
 * clients re-quote, and a landed tx can only land once per blockhash).
 */
export function createGasStationHandler(
  config: GasStationConfig
): (ctx: StoreHandlerContext) => Promise<StoreHandlerResponse> {
  const now = config.now ?? Date.now;
  const quoteTtlMs = config.quoteTtlMs ?? QUOTE_TTL_MS;
  const confirmTimeoutMs = config.confirm?.timeoutMs ?? 45_000;
  const confirmIntervalMs = config.confirm?.intervalMs ?? 2_000;
  const quotes = new Map<string, QuoteRecord>();
  const idempotency = new Map<string, GasStationExecuteReceipt>();

  let depsPromise: Promise<{ deps: GasStationDeps; policy: GasStationPolicy }> | undefined;
  const getDeps = () => {
    depsPromise ??= (config.loadDeps ?? defaultLoadGasStationDeps)({
      network: config.network,
      solanaSecretKey: config.solanaSecretKey,
    })
      .then((deps) => {
        const policy: GasStationPolicy = {
          ...DEFAULT_POLICY,
          ...config.policy,
          feePayer: deps.signer.address,
          programWhitelist: new Set([
            SYSTEM_PROGRAM,
            COMPUTE_BUDGET_PROGRAM,
            MPL_CORE_PROGRAM,
            ...deps.arioProgramIds,
          ]),
        };
        return { deps, policy };
      })
      .catch((err: unknown) => {
        depsPromise = undefined;
        throw err;
      });
    return depsPromise;
  };

  const failed = (
    phase: 'quote' | 'execute',
    reason: GasStationFailureReason,
    detail: string
  ): StoreHandlerResponse => {
    console.warn(`[store] gas-station ${phase} rejected: ${reason} — ${detail}`);
    return accept({
      job: 'gas-station',
      phase,
      status: 'failed',
      network: config.network,
      reason,
      detail,
    });
  };

  async function runQuote(
    event: NostrEvent,
    deps: GasStationDeps,
    policy: GasStationPolicy
  ): Promise<StoreHandlerResponse> {
    const draft = paramTag(event, 'transaction');
    const { blockhash } = await deps.rpc.getLatestBlockhash();
    const preLamports = await deps.rpc.getBalance(policy.feePayer);

    let maxLamports = policy.defaultMaxLamports;
    if (draft !== undefined) {
      // Draft txs get the full static gate too — cheap, and it means a
      // client learns about a policy violation at quote time, for free.
      const inspection = inspectGasStationTransaction(draft, policy);
      if (!inspection.ok) {
        return failed('quote', inspection.reason, inspection.detail);
      }
      const sim = await deps.rpc.simulateTransaction(draft, {
        replaceRecentBlockhash: true, // draft may carry any placeholder blockhash
        feePayer: policy.feePayer,
      });
      if (sim.err !== null && sim.err !== undefined) {
        return failed(
          'quote',
          'simulation_failed',
          `draft simulation error: ${JSON.stringify(sim.err)}; logs: ${sim.logs.slice(-4).join(' | ')}`
        );
      }
      const post = sim.feePayerPostLamports;
      const delta = post === null ? 0n : preLamports - post;
      // 20% headroom + a flat pad for fee drift between quote and execute.
      maxLamports = delta + delta / 5n + 20_000n;
    }
    if (maxLamports > policy.maxLamportsCeiling) {
      return failed(
        'quote',
        'quote_refused',
        `quoted ${maxLamports} lamports exceeds the per-job ceiling ${policy.maxLamportsCeiling}`
      );
    }
    if (preLamports < maxLamports * 2n) {
      return failed(
        'quote',
        'float_exhausted',
        `fee-payer float ${preLamports} lamports cannot cover this job (needs ≥ ${maxLamports * 2n})`
      );
    }

    const record: QuoteRecord = {
      quoteId: randomUUID(),
      maxLamports,
      blockhash,
      expiresAt: now() + quoteTtlMs,
    };
    quotes.set(record.quoteId, record);

    return accept({
      job: 'gas-station',
      phase: 'quote',
      status: 'ok',
      network: config.network,
      quoteId: record.quoteId,
      feePayer: policy.feePayer,
      maxLamports: record.maxLamports.toString(),
      recentBlockhash: record.blockhash,
      expiresAt: record.expiresAt,
    });
  }

  async function runExecute(
    event: NostrEvent,
    deps: GasStationDeps,
    policy: GasStationPolicy
  ): Promise<StoreHandlerResponse> {
    const wireBase64 = paramTag(event, 'transaction');
    const quoteId = paramTag(event, 'quoteId');
    const idempotencyKey = paramTag(event, 'idempotencyKey');
    if (!wireBase64 || !quoteId || !idempotencyKey) {
      return failed(
        'execute',
        'malformed_transaction',
        "execute needs ['param','transaction'], ['param','quoteId'] and ['param','idempotencyKey']"
      );
    }

    // Idempotent replay: a key that landed returns the original result.
    const replay = idempotency.get(idempotencyKey);
    if (replay) {
      return accept({ ...replay, replayed: true });
    }

    const quote = quotes.get(quoteId);
    if (!quote) {
      return failed('execute', 'unknown_quote', `no quote ${quoteId} — request a fresh quote first`);
    }
    if (now() > quote.expiresAt) {
      return failed('execute', 'quote_expired', `quote ${quoteId} expired at ${new Date(quote.expiresAt).toISOString()} — re-quote and re-sign`);
    }

    // ── Mitigations (b) + (d): the static gate ──────────────────────────────
    const inspection = inspectGasStationTransaction(wireBase64, policy);
    if (!inspection.ok) {
      return failed('execute', inspection.reason, inspection.detail);
    }
    // The merged deadline: the tx must be built against the quoted blockhash.
    if (inspection.recentBlockhash !== quote.blockhash) {
      return failed(
        'execute',
        'blockhash_mismatch',
        `transaction blockhash ${inspection.recentBlockhash} is not the quoted ${quote.blockhash} — rebuild against the quote`
      );
    }

    // ── Mitigation (c): simulate + delta cap ────────────────────────────────
    const preLamports = await deps.rpc.getBalance(policy.feePayer);
    const sim = await deps.rpc.simulateTransaction(wireBase64, {
      replaceRecentBlockhash: false,
      feePayer: policy.feePayer,
    });
    if (sim.err !== null && sim.err !== undefined) {
      const rendered = JSON.stringify(sim.err);
      const reason: GasStationFailureReason = rendered.includes('BlockhashNotFound')
        ? 'blockhash_expired'
        : 'simulation_failed';
      return failed('execute', reason, `simulation error: ${rendered}; logs: ${sim.logs.slice(-4).join(' | ')}`);
    }
    const post = sim.feePayerPostLamports;
    if (post === null) {
      return failed('execute', 'simulation_failed', 'simulation returned no fee-payer account state');
    }
    const delta = preLamports - post;
    if (delta > quote.maxLamports) {
      // Inspection passed but simulation shows an over-cap debit: per #163 §6
      // this combination is the signature of an inspection-bypass attempt.
      console.error(
        `[store] gas-station ALARM: simulated fee-payer delta ${delta} lamports exceeds cap ${quote.maxLamports} after static inspection passed (possible bypass attempt)`
      );
      return failed('execute', 'delta_cap_exceeded', `simulated fee-payer debit ${delta} lamports exceeds the quoted cap ${quote.maxLamports}`);
    }

    // ── Co-sign as fee payer + broadcast ────────────────────────────────────
    const gasSignature = await deps.signer.sign(inspection.messageBytes);
    const fullTx = {
      messageBytes: inspection.messageBytes,
      signatures: {
        ...inspection.signatures,
        [policy.feePayer]: gasSignature,
      },
    };
    const signedBase64 = getBase64EncodedWireTransaction(
      fullTx as never
    ) as string;

    let signature: string;
    try {
      signature = await deps.rpc.sendTransaction(signedBase64);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason: GasStationFailureReason = /blockhash/i.test(message)
        ? 'blockhash_expired'
        : 'broadcast_failed';
      return failed('execute', reason, `broadcast failed: ${message}`);
    }

    // ── Confirm ─────────────────────────────────────────────────────────────
    const deadline = now() + confirmTimeoutMs;
    let slot: bigint | null = null;
    let confirmed = false;
    while (now() < deadline) {
      const status = await deps.rpc.getSignatureStatus(signature);
      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        if (status.err) {
          return failed('execute', 'broadcast_failed', `transaction ${signature} landed but FAILED on-chain: ${JSON.stringify(status.err)}`);
        }
        slot = status.slot;
        confirmed = true;
        break;
      }
      await sleep(confirmIntervalMs);
    }
    if (!confirmed) {
      return failed('execute', 'confirmation_timeout', `transaction ${signature} was broadcast but not confirmed within ${confirmTimeoutMs}ms — it may still land; retry with the same idempotencyKey`);
    }

    const feeLamportsActual = await deps.rpc.getTransactionFee(signature);
    const receipt: GasStationExecuteReceipt = {
      job: 'gas-station',
      phase: 'execute',
      status: 'ok',
      network: config.network,
      quoteId,
      idempotencyKey,
      signature,
      slot: slot === null ? null : slot.toString(),
      feeLamportsActual:
        feeLamportsActual === null ? null : feeLamportsActual.toString(),
    };
    idempotency.set(idempotencyKey, receipt);
    quotes.delete(quoteId); // one execution per quote
    return accept(receipt);
  }

  return async (ctx) => {
    const event = ctx.decode();
    if (event.kind !== GAS_STATION_KIND) {
      return ctx.reject('F00', `gas-station handler received kind:${event.kind}, expected kind:${GAS_STATION_KIND}`);
    }
    const phase = paramTag(event, 'phase');
    if (phase !== 'quote' && phase !== 'execute') {
      return ctx.reject('F00', "kind:5096 needs ['param','phase','quote'|'execute']");
    }
    try {
      const { deps, policy } = await getDeps();
      return phase === 'quote'
        ? await runQuote(event, deps, policy)
        : await runExecute(event, deps, policy);
    } catch (err) {
      return ctx.reject('T00', `gas-station ${phase} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
