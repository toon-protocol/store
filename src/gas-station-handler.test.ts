/**
 * Unit tests for the kind:5096 gas-station handler (toon-meta#163).
 *
 * HARD SAFETY: no test touches a live cluster — transactions are compiled
 * offline with @solana/kit and the handler runs against stub RPC/signer
 * seams. The adversarial drills here are the offline twins of the live
 * devnet drills (crafted drain tx → dvm_key_misplaced, Memo →
 * program_not_whitelisted, expiry → quote_expired, delta cap → alarm).
 */

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createKeyPairFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from '@solana/kit';
import {
  COMPUTE_BUDGET_PROGRAM,
  createGasStationHandler,
  DEFAULT_POLICY,
  GAS_STATION_KIND,
  inspectGasStationTransaction,
  MPL_CORE_PROGRAM,
  SYSTEM_PROGRAM,
  type GasStationDeps,
  type GasStationExecuteReceipt,
  type GasStationFailureReceipt,
  type GasStationPolicy,
  type GasStationQuoteReceipt,
  type GasStationRpc,
} from './gas-station-handler.js';
import type { StoreHandlerContext } from './store-backend.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const GAS = 'HHX57jLjbNAqvqf1gkHwArym7qE9dAQooGVdrmbcscWU';
const ANT_PROGRAM = 'DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

/** Deterministic "client" keypair (never funded, offline only). */
async function clientKeyPair() {
  const kp = await createKeyPairFromPrivateKeyBytes(
    new Uint8Array(32).fill(7)
  );
  return { kp, address: String(await getAddressFromPublicKey(kp.publicKey)) };
}

function systemTransferIx(
  from: string,
  to: string,
  lamports: bigint
): Instruction {
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true);
  dv.setBigUint64(4, lamports, true);
  return {
    programAddress: address(SYSTEM_PROGRAM),
    accounts: [
      { address: address(from), role: 3 }, // writable signer
      { address: address(to), role: 1 }, // writable
    ],
    data,
  } as Instruction;
}

/** A fake ar.io ANT instruction whose account list includes `who`. */
function antIxReferencing(who: string, signer = false): Instruction {
  return {
    programAddress: address(ANT_PROGRAM),
    accounts: [{ address: address(who), role: signer ? 3 : 1 }],
    data: new Uint8Array([1, 2, 3]),
  } as Instruction;
}

function memoIx(): Instruction {
  return {
    programAddress: address(MEMO_PROGRAM),
    accounts: [],
    data: new Uint8Array([104, 105]),
  } as Instruction;
}

function computeBudgetIx(disc: 2 | 3, value: bigint): Instruction {
  const data = new Uint8Array(disc === 2 ? 5 : 9);
  data[0] = disc;
  const dv = new DataView(data.buffer);
  if (disc === 2) dv.setUint32(1, Number(value), true);
  else dv.setBigUint64(1, value, true);
  return {
    programAddress: address(COMPUTE_BUDGET_PROGRAM),
    accounts: [],
    data,
  } as Instruction;
}

/** Build (and optionally client-sign) a wire tx with GAS as fee payer. */
async function buildTx(
  instructions: Instruction[],
  opts: { feePayer?: string; sign?: boolean; blockhash?: string } = {}
): Promise<string> {
  const { kp } = await clientKeyPair();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(opts.feePayer ?? GAS), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(opts.blockhash ?? BLOCKHASH),
          lastValidBlockHeight: 1n,
        },
        m
      ),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  let tx = compileTransaction(message);
  if (opts.sign !== false) {
    try {
      tx = await partiallySignTransaction([kp], tx);
    } catch {
      // The client key is not a required signer of this tx (e.g. a crafted
      // gas-wallet-only drill tx) — leave it with only the fee-payer slot.
    }
  }
  return getBase64EncodedWireTransaction(tx);
}

function policyWith(overrides: Partial<GasStationPolicy> = {}): GasStationPolicy {
  return {
    ...DEFAULT_POLICY,
    feePayer: GAS,
    programWhitelist: new Set([
      SYSTEM_PROGRAM,
      COMPUTE_BUDGET_PROGRAM,
      MPL_CORE_PROGRAM,
      ANT_PROGRAM,
    ]),
    ...overrides,
  };
}

// ── inspectGasStationTransaction (mitigations b + d) ────────────────────────

describe('inspectGasStationTransaction', () => {
  it('accepts a client-signed ANT write with the gas wallet only as fee payer', async () => {
    const { address: client } = await clientKeyPair();
    const wire = await buildTx([antIxReferencing(client, true)]);
    const res = inspectGasStationTransaction(wire, policyWith());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.recentBlockhash).toBe(BLOCKHASH);
  });

  it('rejects a foreign fee payer (fee_payer_mismatch)', async () => {
    const { address: client } = await clientKeyPair();
    const wire = await buildTx([antIxReferencing(client, true)], {
      feePayer: client,
    });
    expect(inspectGasStationTransaction(wire, policyWith())).toMatchObject({
      ok: false,
      reason: 'fee_payer_mismatch',
    });
  });

  it('DRILL: a crafted tx using the gas wallet as an ar.io authority is dvm_key_misplaced', async () => {
    const wire = await buildTx([antIxReferencing(GAS, false)]);
    expect(inspectGasStationTransaction(wire, policyWith())).toMatchObject({
      ok: false,
      reason: 'dvm_key_misplaced',
    });
  });

  it('DRILL: a non-whitelisted program (Memo) is program_not_whitelisted', async () => {
    const { address: client } = await clientKeyPair();
    const wire = await buildTx([antIxReferencing(client, true), memoIx()]);
    expect(inspectGasStationTransaction(wire, policyWith())).toMatchObject({
      ok: false,
      reason: 'program_not_whitelisted',
    });
  });

  it('allows a rent-funding System transfer FROM the gas wallet inside the allowance', async () => {
    const { address: client } = await clientKeyPair();
    const wire = await buildTx([
      systemTransferIx(GAS, client, 3_000_000n),
      antIxReferencing(client, true),
    ]);
    expect(inspectGasStationTransaction(wire, policyWith()).ok).toBe(true);
  });

  it('rejects rent funding beyond the allowance (dvm_key_misplaced)', async () => {
    const { address: client } = await clientKeyPair();
    const wire = await buildTx([
      systemTransferIx(GAS, client, DEFAULT_POLICY.rentAllowanceLamports + 1n),
    ]);
    expect(inspectGasStationTransaction(wire, policyWith())).toMatchObject({
      ok: false,
      reason: 'dvm_key_misplaced',
    });
  });

  it('rejects an unknown System instruction touching the gas wallet', async () => {
    const { address: client } = await clientKeyPair();
    // System "Assign" (discriminator 1) referencing the fee payer.
    const data = new Uint8Array(36);
    new DataView(data.buffer).setUint32(0, 1, true);
    const ix = {
      programAddress: address(SYSTEM_PROGRAM),
      accounts: [{ address: address(GAS), role: 3 }],
      data,
    } as Instruction;
    const wire = await buildTx([ix, antIxReferencing(client, true)]);
    expect(inspectGasStationTransaction(wire, policyWith())).toMatchObject({
      ok: false,
      reason: 'dvm_key_misplaced',
    });
  });

  it('allows the MPL Core CreateV1 payer slot, rejects other MPL slots', async () => {
    const { address: client } = await clientKeyPair();
    const mkMpl = (accounts: { address: string; role: number }[], disc = 0) =>
      ({
        programAddress: address(MPL_CORE_PROGRAM),
        accounts: accounts.map((a) => ({
          address: address(a.address),
          role: a.role,
        })),
        data: new Uint8Array([disc]),
      }) as Instruction;

    // payer at instruction-account index 3 (asset, collection, authority, payer, …)
    const okWire = await buildTx([
      mkMpl([
        { address: client, role: 3 },
        { address: MPL_CORE_PROGRAM, role: 0 },
        { address: client, role: 2 },
        { address: GAS, role: 3 },
      ]),
    ]);
    expect(inspectGasStationTransaction(okWire, policyWith()).ok).toBe(true);

    // gas wallet in the authority slot (index 2) instead
    const badWire = await buildTx([
      mkMpl([
        { address: client, role: 3 },
        { address: MPL_CORE_PROGRAM, role: 0 },
        { address: GAS, role: 3 },
        { address: client, role: 3 },
      ]),
    ]);
    expect(inspectGasStationTransaction(badWire, policyWith())).toMatchObject({
      ok: false,
      reason: 'dvm_key_misplaced',
    });
  });

  it('caps the ComputeBudget priority fee (priority_fee_exceeded)', async () => {
    const { address: client } = await clientKeyPair();
    const ok = await buildTx([
      computeBudgetIx(2, 400_000n), // limit
      computeBudgetIx(3, 100n), // price → 40 lamports
      antIxReferencing(client, true),
    ]);
    expect(inspectGasStationTransaction(ok, policyWith()).ok).toBe(true);

    const tooHigh = await buildTx([
      computeBudgetIx(2, 400_000n),
      computeBudgetIx(3, 1_000_000n), // 400_000 lamports > 200_000 cap
      antIxReferencing(client, true),
    ]);
    expect(inspectGasStationTransaction(tooHigh, policyWith())).toMatchObject({
      ok: false,
      reason: 'priority_fee_exceeded',
    });
  });

  it('rejects an unsigned client authority (missing_client_signature)', async () => {
    const { address: client } = await clientKeyPair();
    const wire = await buildTx([antIxReferencing(client, true)], {
      sign: false,
    });
    expect(inspectGasStationTransaction(wire, policyWith())).toMatchObject({
      ok: false,
      reason: 'missing_client_signature',
    });
  });

  it('rejects garbage (malformed_transaction)', () => {
    expect(inspectGasStationTransaction('!!!', policyWith())).toMatchObject({
      ok: false,
      reason: 'malformed_transaction',
    });
  });
});

// ── createGasStationHandler (quote → execute, mitigation c, idempotency) ────

function jobEvent(params: Record<string, string>, kind = GAS_STATION_KIND): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: 'b'.repeat(64),
    sig: 'c'.repeat(128),
    kind,
    created_at: 1_700_000_000,
    content: '',
    tags: Object.entries(params).map(([k, v]) => ['param', k, v]),
  };
}

function ctxFor(event: NostrEvent): StoreHandlerContext {
  return {
    toon: '',
    kind: event.kind,
    pubkey: event.pubkey,
    amount: 0n,
    destination: 'g.connector.store',
    decode: () => event,
    accept: (metadata) => ({ accept: true, ...(metadata ? { metadata } : {}) }),
    reject: (code, message) => ({ accept: false, code, message }),
  };
}

function decodeReceipt<T>(res: unknown): T {
  const r = res as { accept: boolean; data?: string };
  expect(r.accept).toBe(true);
  return JSON.parse(Buffer.from(r.data!, 'base64').toString('utf8')) as T;
}

interface StubOptions {
  balance?: bigint;
  simPostLamports?: bigint | ((pre: bigint) => bigint);
  simErr?: unknown;
  confirm?: boolean;
}

function makeStubDeps(opts: StubOptions = {}) {
  const balance = opts.balance ?? 300_000_000n;
  const sent: string[] = [];
  const rpc: GasStationRpc = {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH })),
    getBalance: vi.fn(async () => balance),
    simulateTransaction: vi.fn(async () => ({
      err: opts.simErr ?? null,
      logs: ['log'],
      feePayerPostLamports:
        typeof opts.simPostLamports === 'function'
          ? opts.simPostLamports(balance)
          : (opts.simPostLamports ?? balance - 10_000n),
    })),
    sendTransaction: vi.fn(async (wire: string) => {
      sent.push(wire);
      return 'STUB_SIGNATURE';
    }),
    getSignatureStatus: vi.fn(async () =>
      (opts.confirm ?? true)
        ? { confirmationStatus: 'confirmed', err: null, slot: 42n }
        : null
    ),
    getTransactionFee: vi.fn(async () => 10_000n),
  };
  const deps: GasStationDeps = {
    rpc,
    signer: {
      address: GAS,
      sign: vi.fn(async () => new Uint8Array(64).fill(9)),
    },
    arioProgramIds: [ANT_PROGRAM],
  };
  return { deps, rpc, sent };
}

function makeHandler(opts: StubOptions & { now?: () => number } = {}) {
  const stub = makeStubDeps(opts);
  const handler = createGasStationHandler({
    network: 'devnet',
    solanaSecretKey: new Uint8Array(64).fill(1),
    loadDeps: async () => stub.deps,
    now: opts.now,
    confirm: { timeoutMs: 200, intervalMs: 10 },
  });
  return { handler, ...stub };
}

async function quoteThenTx(
  handler: (ctx: StoreHandlerContext) => Promise<unknown>,
  instructions?: Instruction[]
) {
  const quoteRes = await handler(ctxFor(jobEvent({ phase: 'quote' })));
  const quote = decodeReceipt<GasStationQuoteReceipt>(quoteRes);
  expect(quote.status).toBe('ok');
  const { address: client } = await clientKeyPair();
  const wire = await buildTx(
    instructions ?? [antIxReferencing(client, true)],
    { blockhash: quote.recentBlockhash }
  );
  return { quote, wire };
}

describe('createGasStationHandler', () => {
  it('quote returns feePayer + blockhash + merged deadline; execute co-signs, broadcasts, confirms', async () => {
    const { handler, rpc, sent } = makeHandler();
    const { quote, wire } = await quoteThenTx(handler);
    expect(quote.feePayer).toBe(GAS);
    expect(BigInt(quote.maxLamports)).toBe(DEFAULT_POLICY.defaultMaxLamports);
    expect(quote.expiresAt).toBeGreaterThan(Date.now() - 1000);

    const res = await handler(
      ctxFor(
        jobEvent({
          phase: 'execute',
          transaction: wire,
          quoteId: quote.quoteId,
          idempotencyKey: 'idem-1',
        })
      )
    );
    const receipt = decodeReceipt<GasStationExecuteReceipt>(res);
    expect(receipt).toMatchObject({
      status: 'ok',
      signature: 'STUB_SIGNATURE',
      slot: '42',
      feeLamportsActual: '10000',
    });
    expect(sent).toHaveLength(1);
    // The broadcast wire is the client tx + the gas signature slot filled.
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('replays an idempotencyKey without re-broadcasting', async () => {
    const { handler, sent } = makeHandler();
    const { quote, wire } = await quoteThenTx(handler);
    const params = {
      phase: 'execute',
      transaction: wire,
      quoteId: quote.quoteId,
      idempotencyKey: 'idem-replay',
    };
    decodeReceipt<GasStationExecuteReceipt>(await handler(ctxFor(jobEvent(params))));
    const second = decodeReceipt<GasStationExecuteReceipt>(
      await handler(ctxFor(jobEvent(params)))
    );
    expect(second.replayed).toBe(true);
    expect(second.signature).toBe('STUB_SIGNATURE');
    expect(sent).toHaveLength(1);
  });

  it('DRILL: submit after expiresAt → quote_expired, nothing signed; re-quote works', async () => {
    let t = 1_000_000;
    const { handler, sent } = makeHandler({ now: () => t });
    const { quote, wire } = await quoteThenTx(handler);
    t += 61_000; // past the merged deadline
    const res = decodeReceipt<GasStationFailureReceipt>(
      await handler(
        ctxFor(
          jobEvent({
            phase: 'execute',
            transaction: wire,
            quoteId: quote.quoteId,
            idempotencyKey: 'idem-exp',
          })
        )
      )
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'quote_expired' });
    expect(sent).toHaveLength(0);
    // Re-quote succeeds cleanly.
    const again = decodeReceipt<GasStationQuoteReceipt>(
      await handler(ctxFor(jobEvent({ phase: 'quote' })))
    );
    expect(again.status).toBe('ok');
  });

  it('DRILL: drain-shaped tx (gas wallet as ar.io slot) → dvm_key_misplaced, no signing, no broadcast', async () => {
    const { handler, deps, sent } = makeHandler();
    const quote = decodeReceipt<GasStationQuoteReceipt>(
      await handler(ctxFor(jobEvent({ phase: 'quote' })))
    );
    const wire = await buildTx([antIxReferencing(GAS, false)], {
      blockhash: quote.recentBlockhash,
    });
    const res = decodeReceipt<GasStationFailureReceipt>(
      await handler(
        ctxFor(
          jobEvent({
            phase: 'execute',
            transaction: wire,
            quoteId: quote.quoteId,
            idempotencyKey: 'idem-drain',
          })
        )
      )
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'dvm_key_misplaced' });
    expect(deps.signer.sign).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('DRILL: over-cap simulated debit → delta_cap_exceeded + alarm, no broadcast', async () => {
    const { handler, sent } = makeHandler({
      simPostLamports: (pre) => pre - DEFAULT_POLICY.defaultMaxLamports - 1n,
    });
    const alarm = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { quote, wire } = await quoteThenTx(handler);
      const res = decodeReceipt<GasStationFailureReceipt>(
        await handler(
          ctxFor(
            jobEvent({
              phase: 'execute',
              transaction: wire,
              quoteId: quote.quoteId,
              idempotencyKey: 'idem-cap',
            })
          )
        )
      );
      expect(res).toMatchObject({ status: 'failed', reason: 'delta_cap_exceeded' });
      expect(sent).toHaveLength(0);
      expect(alarm).toHaveBeenCalledWith(expect.stringContaining('ALARM'));
    } finally {
      alarm.mockRestore();
    }
  });

  it('rejects a tx built against a different blockhash (blockhash_mismatch)', async () => {
    const { handler } = makeHandler();
    const quote = decodeReceipt<GasStationQuoteReceipt>(
      await handler(ctxFor(jobEvent({ phase: 'quote' })))
    );
    const { address: client } = await clientKeyPair();
    const wire = await buildTx([antIxReferencing(client, true)], {
      blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1M', // ≠ quoted
    });
    const res = decodeReceipt<GasStationFailureReceipt>(
      await handler(
        ctxFor(
          jobEvent({
            phase: 'execute',
            transaction: wire,
            quoteId: quote.quoteId,
            idempotencyKey: 'idem-bh',
          })
        )
      )
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'blockhash_mismatch' });
  });

  it('unknown quote id → unknown_quote', async () => {
    const { handler } = makeHandler();
    const { wire } = await quoteThenTx(handler);
    const res = decodeReceipt<GasStationFailureReceipt>(
      await handler(
        ctxFor(
          jobEvent({
            phase: 'execute',
            transaction: wire,
            quoteId: 'nope',
            idempotencyKey: 'idem-uq',
          })
        )
      )
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'unknown_quote' });
  });

  it('quote refuses when the float cannot cover the job (float_exhausted)', async () => {
    const { handler } = makeHandler({ balance: 100n });
    const res = decodeReceipt<GasStationFailureReceipt>(
      await handler(ctxFor(jobEvent({ phase: 'quote' })))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'float_exhausted' });
  });

  it('a draft-tx quote prices from the simulated delta', async () => {
    const { handler } = makeHandler({
      simPostLamports: (pre) => pre - 2_000_000n,
    });
    const { address: client } = await clientKeyPair();
    const draft = await buildTx([
      systemTransferIx(GAS, client, 1_990_000n),
      antIxReferencing(client, true),
    ]);
    const res = decodeReceipt<GasStationQuoteReceipt>(
      await handler(ctxFor(jobEvent({ phase: 'quote', transaction: draft })))
    );
    expect(res.status).toBe('ok');
    // delta 2_000_000 + 20% + 20_000 pad
    expect(BigInt(res.maxLamports)).toBe(2_420_000n);
  });

  it('wrong kind / missing phase are transport rejects (F00)', async () => {
    const { handler } = makeHandler();
    expect(
      await handler(ctxFor(jobEvent({ phase: 'quote' }, 5094)))
    ).toMatchObject({ accept: false, code: 'F00' });
    expect(await handler(ctxFor(jobEvent({})))).toMatchObject({
      accept: false,
      code: 'F00',
    });
  });
});
