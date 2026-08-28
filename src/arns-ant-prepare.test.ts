/**
 * Unit tests for the kind:5095 `op=prepare` ANT-spawn composition.
 *
 * HARD SAFETY RULE: no test here touches the live ar.io registry, opens a
 * socket, or spends real (or devnet) $ARIO or SOL. The whole prepare path is
 * pure and offline — the only network-derived input is a blockhash the caller
 * supplies — so the composition tests run the REAL builders and assert on the
 * compiled bytes rather than on a stub's say-so.
 *
 * The byte assertions are not incidental detail: they ARE the gas station's
 * pre-sign contract, restated locally. If `@ar.io/solana-contracts` ever
 * reorders MPL Core's `CreateV1` accounts, or the ario-ant program id moves,
 * the flow dead-ends at `dvm_key_misplaced` or `program_not_whitelisted` on
 * devnet — after a paid quote. These tests are what make that a local failure.
 *
 * Covers:
 *   - parseArnsAntPrepareParams: param-tag parsing, defaults, the three
 *     key-collision rejections
 *   - buildAntSpawnTransaction: instruction bundle, rent arithmetic, and every
 *     rule the gas station's inspector enforces
 *   - createArnsBuyHandler: op dispatch, and that prepare never loads the
 *     buy SDK
 *   - startStoreBackend: a prepare job surfaced as `result`
 */

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import {
  COMPUTE_BUDGET_PROGRAM,
  PLACEHOLDER_BLOCKHASH,
  SPAWN_COMPUTE_UNIT_LIMIT,
  SYSTEM_PROGRAM,
  buildAntSpawnTransaction,
  defaultLoadArnsPrepareDeps,
  parseArnsAntPrepareParams,
  rentLamports,
  type ArnsAntPrepareParams,
  type ArnsAntPrepareReceipt,
  type ArnsPrepareDeps,
} from './arns-ant-prepare.js';
import { ARNS_BUY_KIND, createArnsBuyHandler } from './arns-buy-handler.js';
import {
  startStoreBackend,
  type StoreHandler,
  type StoreHandlerContext,
} from './store-backend.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

// Deterministic, structurally valid base58 pubkeys (32 bytes of one value).
const FEE_PAYER = 'k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn';
const MINT = '2VDW9dFE1ZXz4zWAbaBDQFynNVdRpQ73HyfSHMzBSL6Z';
const OWNER = '3EKkiwNLWqoUbzFkPrmKbtUB4EweE6f4STzevYUmezeL';
const BLOCKHASH = 'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN';

/** MPL Core, as the gas station hardcodes it. Drift here breaks the flow. */
const GAS_STATION_MPL_CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
/** ario-ant on devnet, as the gas station whitelists it. */
const GAS_STATION_ANT_DEVNET = 'DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX';

/** The AR.IO logo tx — the SDK's default root-record target. */
const DEFAULT_TARGET = 'AnYvLJTWcG9lr2Ll5MwYWZR2o5uTE39WbpYB0zCxwKM';

const NAME = 'toon-demo';

function prepareEvent(
  params: Record<string, string>,
  kind = ARNS_BUY_KIND
): NostrEvent {
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

const BASE_PARAMS = {
  op: 'prepare',
  name: NAME,
  owner: OWNER,
  mint: MINT,
  feePayer: FEE_PAYER,
};

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

interface DecodedInstruction {
  program: string;
  indices: number[];
  data: Uint8Array;
}

/** Look something up positionally, failing loudly rather than yielding undefined. */
function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no ${what} at index ${index}`);
  return item;
}

/** Decode a compiled wire transaction back to the shape the gas station sees. */
function decodeWire(wireBase64: string) {
  const tx = getTransactionDecoder().decode(Buffer.from(wireBase64, 'base64'));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const accounts = message.staticAccounts as unknown as string[];
  const instructions: DecodedInstruction[] = message.instructions.map((ix) => ({
    program: at(accounts, ix.programAddressIndex, 'program account'),
    indices: [...(ix.accountIndices ?? [])],
    data: Uint8Array.from(ix.data ?? []),
  }));
  return {
    tx,
    accounts,
    header: message.header,
    byteLength: Buffer.from(wireBase64, 'base64').length,
    instructions,
    /** The one instruction invoking `program`; fails if absent or ambiguous. */
    only(program: string): DecodedInstruction {
      const found = instructions.filter((ix) => ix.program === program);
      if (found.length !== 1) {
        throw new Error(
          `expected exactly 1 instruction for ${program}, found ${found.length}`
        );
      }
      return at(found, 0, 'instruction');
    },
  };
}

/** Little-endian u32 at `offset` of an instruction's data. */
function u32At(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
    offset,
    true
  );
}

/** Real, offline deps. No RPC, no key, no spend. */
const realDeps = (): Promise<ArnsPrepareDeps> =>
  defaultLoadArnsPrepareDeps({ network: 'devnet' });

async function buildReal(
  overrides: Partial<ArnsAntPrepareParams> = {}
): Promise<ArnsAntPrepareReceipt> {
  const deps = await realDeps();
  const params = parseArnsAntPrepareParams(
    prepareEvent(BASE_PARAMS),
    deps.defaultTarget
  );
  return buildAntSpawnTransaction({ ...params, ...overrides }, deps, 'devnet');
}

// ── parseArnsAntPrepareParams ───────────────────────────────────────────────

describe('parseArnsAntPrepareParams', () => {
  it('parses a minimal prepare and applies the documented defaults', () => {
    const params = parseArnsAntPrepareParams(
      prepareEvent(BASE_PARAMS),
      DEFAULT_TARGET
    );
    expect(params).toEqual({
      name: NAME,
      owner: OWNER,
      mint: MINT,
      feePayer: FEE_PAYER,
      recentBlockhash: PLACEHOLDER_BLOCKHASH,
      draft: true,
      initializeAnt: true,
      target: DEFAULT_TARGET,
      ticker: null,
    });
  });

  it('a supplied blockhash clears the draft flag', () => {
    const params = parseArnsAntPrepareParams(
      prepareEvent({ ...BASE_PARAMS, recentBlockhash: BLOCKHASH }),
      DEFAULT_TARGET
    );
    expect(params.recentBlockhash).toBe(BLOCKHASH);
    expect(params.draft).toBe(false);
  });

  it('ignores the buy op’s params rather than rejecting them', () => {
    const params = parseArnsAntPrepareParams(
      prepareEvent({
        ...BASE_PARAMS,
        type: 'permabuy',
        years: '3',
        processId: MINT,
      }),
      DEFAULT_TARGET
    );
    expect(params.name).toBe(NAME);
  });

  it.each([
    [{ name: undefined }, /param','name'/],
    [{ owner: undefined }, /param','owner'/],
    [{ mint: undefined }, /param','mint'/],
    [{ feePayer: undefined }, /param','feePayer'/],
    [{ name: 'UPPER' }, /invalid ArNS name/],
    [{ name: '-lead' }, /invalid ArNS name/],
    [{ owner: 'not-base58-0OIl' }, /invalid owner/],
    [{ mint: 'short' }, /invalid mint/],
    [{ feePayer: 'short' }, /invalid feePayer/],
    [{ recentBlockhash: 'nope' }, /invalid recentBlockhash/],
    [{ initializeAnt: 'yes' }, /invalid initializeAnt/],
    [{ target: 'too-short' }, /invalid target/],
    [{ ticker: '' }, /invalid ticker/],
    [{ ticker: 'x'.repeat(17) }, /invalid ticker/],
  ])('rejects %j', (patch, expected) => {
    const params = Object.fromEntries(
      Object.entries({ ...BASE_PARAMS, ...patch }).filter(
        ([, v]) => v !== undefined
      )
    ) as Record<string, string>;
    expect(() =>
      parseArnsAntPrepareParams(prepareEvent(params), DEFAULT_TARGET)
    ).toThrow(expected);
  });

  // A collision silently merges two static accounts, and the gas station then
  // reports a bare `dvm_key_misplaced` with nothing pointing at the cause.
  it.each([
    [{ mint: OWNER }, /mint and owner must be different/],
    [{ mint: FEE_PAYER }, /mint and feePayer must be different/],
    [{ owner: FEE_PAYER }, /owner and feePayer must be different/],
  ])('rejects colliding keys %j', (patch, expected) => {
    expect(() =>
      parseArnsAntPrepareParams(
        prepareEvent({ ...BASE_PARAMS, ...patch }),
        DEFAULT_TARGET
      )
    ).toThrow(expected);
  });
});

// ── rentLamports ────────────────────────────────────────────────────────────

describe('rentLamports', () => {
  it('matches the SDK’s linear formula (128-byte per-account overhead)', () => {
    // AntConfig 452 + AntControllers 176 + root '@' 316, +128 each.
    expect(rentLamports([452, 176, 316])).toBe(9_242_880n);
    expect(rentLamports([])).toBe(0n);
  });
});

// ── buildAntSpawnTransaction — the gas station's contract, in bytes ─────────

describe('buildAntSpawnTransaction', () => {
  it('emits the four-instruction spawn bundle in order', async () => {
    const receipt = await buildReal();
    expect(receipt.instructions).toEqual([
      'compute-budget-limit',
      'system-transfer',
      'mpl-core-create-v1',
      'ario-ant-initialize',
    ]);
    expect(receipt.processId).toBe(MINT);
    expect(receipt.op).toBe('prepare');
  });

  it('puts the fee payer at static account 0, exactly once', async () => {
    const { accounts } = decodeWire((await buildReal()).transaction);
    expect(accounts[0]).toBe(FEE_PAYER);
    expect(accounts.filter((a) => a === FEE_PAYER)).toHaveLength(1);
  });

  // The single rule the whole flow hangs on: MPL Core is the only program the
  // gas wallet may appear in, and only in CreateV1's payer slot.
  it('puts the gas wallet in CreateV1’s payer slot and nowhere else', async () => {
    const create = decodeWire((await buildReal()).transaction).only(
      GAS_STATION_MPL_CORE
    );
    expect(create.data[0]).toBe(0); // CreateV1 discriminator
    expect(create.indices[3]).toBe(0); // the payer slot, and only it
    expect(create.indices.filter((i) => i === 0)).toHaveLength(1);
  });

  // The bug this exists to prevent: MPL Core defaults an unset `owner` to the
  // PAYER. Leave it unset here and every ANT is minted into the GAS STATION's
  // wallet, not the client's — and nothing says so until `ario_ant::initialize`
  // fails NotNftHolder one instruction later, by which point the asset is made.
  it('mints the asset to the client, not to the fee payer', async () => {
    const decoded = decodeWire((await buildReal()).transaction);
    const create = decoded.only(GAS_STATION_MPL_CORE);
    // CreateV1 accounts: [asset, collection, authority, payer, owner, ...]
    const ownerIdx = at(create.indices, 4, 'owner slot');
    expect(at(decoded.accounts, ownerIdx, 'owner account')).toBe(OWNER);
    expect(ownerIdx).not.toBe(0); // never the fee payer
    // And the authority — who signs the mint — is the client too.
    expect(
      at(decoded.accounts, at(create.indices, 2, 'authority slot'), 'authority')
    ).toBe(OWNER);
  });

  it('keeps the gas wallet out of the ario-ant instruction entirely', async () => {
    const init = decodeWire((await buildReal()).transaction).only(
      GAS_STATION_ANT_DEVNET
    );
    expect(init.indices).not.toContain(0);
  });

  it('invokes only programs the gas station whitelists', async () => {
    const { instructions } = decodeWire((await buildReal()).transaction);
    const allowed = new Set([
      SYSTEM_PROGRAM,
      COMPUTE_BUDGET_PROGRAM,
      GAS_STATION_MPL_CORE,
      GAS_STATION_ANT_DEVNET,
    ]);
    for (const ix of instructions) expect(allowed).toContain(ix.program);
  });

  it('agrees with the gas station on the MPL Core and ario-ant ids', async () => {
    const deps = await realDeps();
    expect(deps.mplCoreProgramId).toBe(GAS_STATION_MPL_CORE);
    expect(deps.antProgramId).toBe(GAS_STATION_ANT_DEVNET);
  });

  it('funds the ANT state PDAs within the gas station’s rent allowance', async () => {
    const receipt = await buildReal();
    const decoded = decodeWire(receipt.transaction);
    const transfer = decoded.only(SYSTEM_PROGRAM);
    expect(u32At(transfer.data, 0)).toBe(2); // System::Transfer
    expect(transfer.indices[0]).toBe(0); // sourced from the fee payer
    expect(at(decoded.accounts, at(transfer.indices, 1, 'account index'), 'account')).toBe(OWNER);

    expect(receipt.rentTransferLamports).toBe('9242880');
    // rentAllowanceLamports in the deployed gas station's DEFAULT_POLICY. The
    // fit is only 757k lamports of headroom, so this is the early warning if
    // the ario-ant PDA layout ever grows.
    expect(BigInt(receipt.rentTransferLamports)).toBeLessThanOrEqual(
      10_000_000n
    );
  });

  it('estimates a fee-payer outlay under the per-job ceiling', async () => {
    const receipt = await buildReal();
    // maxLamportsCeiling, after the quote's 20% headroom + 20k pad.
    const quoted =
      (BigInt(receipt.estimatedFeePayerLamports) * 12n) / 10n + 20_000n;
    expect(quoted).toBeLessThan(20_000_000n);
  });

  it('omits SetComputeUnitPrice so the priority-fee cap never engages', async () => {
    const budget = decodeWire((await buildReal()).transaction).only(
      COMPUTE_BUDGET_PROGRAM
    );
    expect(budget.data[0]).toBe(2); // SetComputeUnitLimit, and nothing else
    expect(u32At(budget.data, 1)).toBe(SPAWN_COMPUTE_UNIT_LIMIT);
  });

  it('leaves every signature slot empty and names who must fill them', async () => {
    const receipt = await buildReal();
    const { tx } = decodeWire(receipt.transaction);
    // The store cannot sign for anyone, so it emits a fully hollow tx. The gas
    // station refuses this shape (`missing_client_signature`) — that refusal is
    // the handoff, not a defect.
    expect(Object.values(tx.signatures).every((s) => s === null)).toBe(true);

    // The fee payer is always slot 0. The remaining signers are ordered by the
    // compiler (address-sorted within a role), NOT semantically — so assert the
    // set, and let the client map by address the way the receipt tells it to.
    expect(receipt.requiredSigners[0]).toBe(FEE_PAYER);
    expect([...receipt.requiredSigners].sort()).toEqual(
      [FEE_PAYER, MINT, OWNER].sort()
    );
    // What the CLIENT must sign before the gas station will look at it.
    expect([...receipt.clientSigners].sort()).toEqual([MINT, OWNER].sort());
    expect(receipt.clientSigners).not.toContain(FEE_PAYER);
    // Slot order must match the wire, whatever that order turns out to be.
    expect(receipt.requiredSigners).toEqual(Object.keys(tx.signatures));
  });

  it('is deterministic but for the 32 blockhash bytes', async () => {
    const a = await buildReal();
    const b = await buildReal({ recentBlockhash: BLOCKHASH, draft: false });
    const ba = Buffer.from(a.transaction, 'base64');
    const bb = Buffer.from(b.transaction, 'base64');
    expect(ba.length).toBe(bb.length);
    let differing = 0;
    for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) differing++;
    expect(differing).toBeLessThanOrEqual(32);
    expect(a.draft).toBe(true);
    expect(b.draft).toBe(false);
  });

  it('initializeAnt=false emits the mint-only bundle with no transfer', async () => {
    const receipt = await buildReal({ initializeAnt: false });
    expect(receipt.instructions).toEqual([
      'compute-budget-limit',
      'mpl-core-create-v1',
    ]);
    expect(receipt.rentTransferLamports).toBe('0');
    const { instructions } = decodeWire(receipt.transaction);
    expect(instructions.map((ix) => ix.program)).not.toContain(SYSTEM_PROGRAM);
    expect(instructions.map((ix) => ix.program)).not.toContain(
      GAS_STATION_ANT_DEVNET
    );
  });

  it('fits in one packet for a maximum-length name', async () => {
    const longName = `${'a'.repeat(50)}z`;
    expect(longName).toHaveLength(51);
    const receipt = await buildReal({ name: longName });
    expect(decodeWire(receipt.transaction).byteLength).toBeLessThan(1232);
  });

  it('targets the mainnet ario-ant program off devnet', async () => {
    const deps = await defaultLoadArnsPrepareDeps({ network: 'mainnet' });
    expect(deps.antProgramId).toBe('2MWexMHfMhGJwMHv9Qm9YAVCqjUFUJwDJAysW4oCUGk5');
    expect(deps.antProgramId).not.toBe(GAS_STATION_ANT_DEVNET);
  });
});

// ── Handler dispatch ────────────────────────────────────────────────────────

describe('createArnsBuyHandler op dispatch', () => {
  const SECRET = new Uint8Array(64).fill(7);

  function handler(overrides: Partial<Parameters<typeof createArnsBuyHandler>[0]> = {}) {
    return createArnsBuyHandler({
      network: 'devnet',
      solanaSecretKey: SECRET,
      loadSdk: vi.fn(async () => {
        throw new Error('the buy SDK must not be loaded for a prepare');
      }),
      loadPrepareDeps: () => realDeps(),
      ...overrides,
    });
  }

  it('routes op=prepare and never loads the buy SDK', async () => {
    const loadSdk = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const res = await handler({ loadSdk })(
      ctxFor(prepareEvent(BASE_PARAMS))
    );
    expect(res.accept).toBe(true);
    const receipt: ArnsAntPrepareReceipt = JSON.parse(
      Buffer.from((res as { data: string }).data, 'base64').toString('utf8')
    );
    expect(receipt.op).toBe('prepare');
    expect(receipt.processId).toBe(MINT);
    // The proof that prepare needs no key, no RPC and no ARIO float.
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('rejects an unknown op with F00', async () => {
    const res = await handler()(
      ctxFor(prepareEvent({ ...BASE_PARAMS, op: 'mint' }))
    );
    expect(res).toMatchObject({ accept: false, code: 'F00' });
    expect((res as { message: string }).message).toMatch(/expected buy \| prepare/);
  });

  it('rejects a malformed prepare param with F00', async () => {
    const res = await handler()(
      ctxFor(prepareEvent({ ...BASE_PARAMS, mint: 'nope' }))
    );
    expect(res).toMatchObject({ accept: false, code: 'F00' });
  });

  it('surfaces a deps-load failure as T00 and retries on the next job', async () => {
    const loadPrepareDeps = vi
      .fn<[{ network: string }], Promise<ArnsPrepareDeps>>()
      .mockRejectedValueOnce(new Error('install broken'))
      .mockImplementation(() => realDeps());
    const h = handler({ loadPrepareDeps });

    const first = await h(ctxFor(prepareEvent(BASE_PARAMS)));
    expect(first).toMatchObject({ accept: false, code: 'T00' });
    expect((first as { message: string }).message).toMatch(/install broken/);

    const second = await h(ctxFor(prepareEvent(BASE_PARAMS)));
    expect(second.accept).toBe(true);
    expect(loadPrepareDeps).toHaveBeenCalledTimes(2);
  });
});

// ── Backend integration ─────────────────────────────────────────────────────

describe('startStoreBackend prepare dispatch', () => {
  it('surfaces the prepare receipt as `result`', async () => {
    const arnsHandler = createArnsBuyHandler({
      network: 'devnet',
      solanaSecretKey: new Uint8Array(64).fill(7),
      loadSdk: vi.fn(async () => {
        throw new Error('unused');
      }),
      loadPrepareDeps: () => realDeps(),
    }) as unknown as StoreHandler;

    const backend = startStoreBackend({
      handle: (async () => {
        throw new Error('kind:5094 handler must not be reached');
      }) as unknown as StoreHandler,
      handlers: { [ARNS_BUY_KIND]: arnsHandler },
      handlerPort: 0,
      devMode: true,
    });

    try {
      // @hono/node-server's serve() returns a node http.Server (structurally).
      const { port } = (
        backend as unknown as { address(): { port: number } }
      ).address();
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: prepareEvent(BASE_PARAMS) }),
      });
      const body = (await res.json()) as {
        accept: boolean;
        result?: ArnsAntPrepareReceipt;
        txId?: string;
      };
      expect(body.accept).toBe(true);
      expect(body.txId).toBeUndefined();
      expect(body.result?.op).toBe('prepare');
      expect(body.result?.transaction).toBeTypeOf('string');
    } finally {
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  });
});
