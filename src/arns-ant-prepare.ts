/**
 * ANT spawn composition — the `op=prepare` half of the kind:5095 ArNS job.
 *
 * `op=buy` (./arns-buy-handler) needs a `processId`: the MPL Core asset pubkey
 * of an ANT the client already owns. Spawning one costs ~0.012 SOL of rent, and
 * a TOON client holds ILP credit, not SOL — so until now kind:5095 had no
 * caller who could satisfy its own precondition. This op closes that: the store
 * composes the spawn transaction, the CLIENT signs it, and the gas station
 * (kind:5096, toon-protocol/gas-station at `g.toon.gas`) pays for it and
 * broadcasts it. Three parties, one transaction, and the store touches no key.
 *
 * WHY THE STORE COMPOSES IT: of the three, only the store has `@ar.io/sdk`. And
 * `spawnSolanaANT` cannot be used here at all — its `signer` is both rent payer
 * AND NFT recipient, welded together, so a DVM calling it would own the result.
 * The split comes from dropping one layer down to the codama builders, where
 * `payer` and `authority` are separate accounts.
 *
 * THE TRANSACTION (`buildAntSpawnTransaction`):
 *
 *   [0] ComputeBudget::SetComputeUnitLimit(400_000)
 *   [1] System::Transfer  feePayer -> owner, {@link antPdaRentLamports}
 *   [2] MPL Core CreateV1  asset=mint  authority=owner  payer=feePayer
 *   [3] ario_ant::initialize  owner=owner (writable signer)
 *
 * Instruction [1] is not a convenience. `ario_ant::initialize` has NO payer
 * account — its `owner` is a `WritableSignerAccount`, so the three ANT state
 * PDAs (AntConfig, AntControllers, root `@` record) are debited from the
 * client. `CreateV1`, by contrast, has a real `payer` slot, so the asset
 * account's rent comes straight off the gas wallet. A zero-SOL client can only
 * pay the PDA half if the fee payer hands it the lamports first, in the same
 * atomic transaction.
 *
 * WHAT THE GAS STATION ENFORCES, and why the shape above is not negotiable:
 * its pre-sign inspector requires the fee payer to be static account 0 and to
 * appear exactly once; it permits the gas wallet inside MPL Core ONLY as the
 * `CreateV1` payer slot (instruction-account index 3); it meters a top-level
 * System transfer sourced from the fee payer against a rent allowance; and it
 * refuses outright any ar.io instruction that references the gas wallet at all.
 * `src/arns-ant-prepare.test.ts` pins every one of those as a byte assertion,
 * because discovering a drift there costs one failed test locally and one
 * `dvm_key_misplaced` plus a wasted quote on devnet.
 *
 * The ACL bootstrap (`register_acl_config` + `add_acl_page`) is deliberately
 * NOT included: it is ~61.4M lamports against a 20M per-job ceiling, and both
 * of its instructions put the payer in an ar.io slot, which that last rule
 * refuses regardless. The spawned ANT resolves fine without it; it just will
 * not appear in "ANTs I own" registry lookups until the client bootstraps it
 * with its own SOL. The SDK documents that registry as an eventually-consistent
 * secondary index, not truth.
 *
 * NO KEY, NO RPC, NO SPEND. Every builder on this path is pure and offline; the
 * only network-derived input is a blockhash, and the CLIENT supplies that (it
 * got it from the gas station's quote). That is why prepare has its own deps
 * seam instead of riding {@link import('./arns-buy-handler.js').ArnsBuySdk} —
 * that one builds a signed write client, and a store with an unfunded ARIO
 * wallet should still be able to compose a transaction.
 */

import {
  ARNS_NAME_REGEX,
  ARWEAVE_TX_REGEX,
  SOLANA_PUBKEY_REGEX,
  paramTag,
  type ArnsNetwork,
} from './arns-params.js';
import type { NostrEvent } from 'nostr-tools/pure';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Solana's System program. */
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** Solana's ComputeBudget program. */
export const COMPUTE_BUDGET_PROGRAM =
  'ComputeBudget111111111111111111111111111111';

/**
 * CU limit for the spawn bundle. Matches the 400_000 `spawnSolanaANT` pins for
 * the same instruction set, so we inherit a number proven against the live
 * program rather than guessing one.
 */
export const SPAWN_COMPUTE_UNIT_LIMIT = 400_000;

/**
 * The blockhash baked in when the caller supplies none. A prepare without a
 * blockhash exists only to be priced: the gas station's quote phase simulates
 * with `replaceRecentBlockhash: true`, so the placeholder never reaches a
 * validator. Executing one would fail `blockhash_mismatch`, which is why the
 * receipt flags it as `draft`.
 */
export const PLACEHOLDER_BLOCKHASH = '11111111111111111111111111111111';

/**
 * Rent-exemption constants, mirroring the offline fallback `@ar.io/sdk`'s
 * `estimateRentLamports` uses when its RPC query fails. Rent is linear in
 * account size with a flat 128-byte per-account overhead, so N accounts cost
 * the same as one account of `Σbytes + 128×N`.
 */
const LAMPORTS_PER_BYTE_YEAR = 6960;
const RENT_ACCOUNT_OVERHEAD_BYTES = 128;

/** Max `ticker` length the ario-ant program accepts. */
const MAX_TICKER_LENGTH = 16;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** Parsed, validated `op=prepare` parameters (from the event's `param` tags). */
export interface ArnsAntPrepareParams {
  /** ANT display name; doubles as the asset name and the initialize name. */
  name: string;
  /** The client's authority key — becomes the ANT's owner. */
  owner: string;
  /**
   * Public half of a client-generated ephemeral keypair. Becomes the MPL Core
   * asset address, which is the `processId` the follow-up `op=buy` wants. The
   * client must keep the private half to sign this transaction.
   */
  mint: string;
  /** The gas station's advertised fee payer, from its kind:5096 quote. */
  feePayer: string;
  /** Blockhash to bake in; {@link PLACEHOLDER_BLOCKHASH} when unspecified. */
  recentBlockhash: string;
  /** True when `recentBlockhash` was defaulted — quote-only, not executable. */
  draft: boolean;
  /** Emit `ario_ant::initialize` + the funding transfer (default true). */
  initializeAnt: boolean;
  /** Arweave tx id the root `@` record points at. */
  target: string;
  /** ANT ticker; null lets the program apply its own default. */
  ticker: string | null;
}

/**
 * Parse + validate the `op=prepare` params. `name` reuses the buy op's ArNS
 * name rule; `owner`, `mint` and `feePayer` are base58 pubkeys and must be
 * three DISTINCT keys — a collision silently merges static accounts and
 * surfaces from the gas station as a bare `dvm_key_misplaced` with nothing
 * pointing back at the real cause, so it is worth catching here by name.
 *
 * `type`, `years` and `processId` belong to the buy op and are ignored rather
 * than rejected: a client reusing one event template should not be punished.
 *
 * @throws {Error} with a client-actionable message on any invalid param.
 */
export function parseArnsAntPrepareParams(
  event: NostrEvent,
  defaultTarget: string
): ArnsAntPrepareParams {
  const name = paramTag(event, 'name');
  if (!name) throw new Error("missing required param tag: ['param','name',…]");
  if (!ARNS_NAME_REGEX.test(name)) {
    throw new Error(
      `invalid ArNS name ${JSON.stringify(name)} — 1–51 lowercase ` +
        'alphanumeric/hyphen chars, no leading/trailing hyphen'
    );
  }

  const pubkey = (key: string, hint: string): string => {
    const raw = paramTag(event, key);
    if (!raw) {
      throw new Error(
        `missing required param tag: ['param','${key}',…] — ${hint}`
      );
    }
    if (!SOLANA_PUBKEY_REGEX.test(raw)) {
      throw new Error(
        `invalid ${key} ${JSON.stringify(raw)} — expected a base58 Solana pubkey`
      );
    }
    return raw;
  };

  const owner = pubkey(
    'owner',
    "the client's authority key; it becomes the ANT's owner"
  );
  const mint = pubkey(
    'mint',
    'the public half of an ephemeral keypair you generate and keep — it ' +
      'becomes the ANT asset address (the processId for op=buy)'
  );
  const feePayer = pubkey(
    'feePayer',
    "the gas station's fee payer, from its kind:5096 quote"
  );

  if (mint === owner) {
    throw new Error('mint and owner must be different keys');
  }
  if (mint === feePayer) {
    throw new Error('mint and feePayer must be different keys');
  }
  if (owner === feePayer) {
    throw new Error('owner and feePayer must be different keys');
  }

  const blockhashRaw = paramTag(event, 'recentBlockhash');
  if (blockhashRaw !== undefined && !SOLANA_PUBKEY_REGEX.test(blockhashRaw)) {
    throw new Error(
      `invalid recentBlockhash ${JSON.stringify(blockhashRaw)} — expected a ` +
        'base58 32-byte blockhash from the gas station quote'
    );
  }

  const initializeRaw = paramTag(event, 'initializeAnt') ?? 'true';
  if (initializeRaw !== 'true' && initializeRaw !== 'false') {
    throw new Error(
      `invalid initializeAnt ${JSON.stringify(initializeRaw)} — expected ` +
        'true | false'
    );
  }

  const target = paramTag(event, 'target') ?? defaultTarget;
  if (!ARWEAVE_TX_REGEX.test(target)) {
    throw new Error(
      `invalid target ${JSON.stringify(target)} — expected a 43-char Arweave ` +
        'transaction id'
    );
  }

  const tickerRaw = paramTag(event, 'ticker');
  if (
    tickerRaw !== undefined &&
    (tickerRaw.length === 0 || tickerRaw.length > MAX_TICKER_LENGTH)
  ) {
    throw new Error(
      `invalid ticker ${JSON.stringify(tickerRaw)} — expected 1–` +
        `${MAX_TICKER_LENGTH} chars`
    );
  }

  return {
    name,
    owner,
    mint,
    feePayer,
    recentBlockhash: blockhashRaw ?? PLACEHOLDER_BLOCKHASH,
    draft: blockhashRaw === undefined,
    initializeAnt: initializeRaw === 'true',
    target,
    ticker: tickerRaw ?? null,
  };
}

// ---------------------------------------------------------------------------
// The deps seam
// ---------------------------------------------------------------------------

/**
 * A Solana instruction, structurally. Deliberately not `@solana/kit`'s
 * `Instruction`: this shape is what a test stub can build without importing
 * the SDK, and `role` matches kit's `AccountRole`
 * (0 READONLY, 1 WRITABLE, 2 READONLY_SIGNER, 3 WRITABLE_SIGNER).
 */
export interface PreparedInstruction {
  programAddress: string;
  accounts: { address: string; role: number }[];
  data: Uint8Array;
}

/** A compiled, unsigned transaction and the signers its wire format expects. */
export interface CompiledUnsignedTransaction {
  /** Base64 wire format. Every signature slot is 64 zero bytes. */
  wireBase64: string;
  /** Signers in compiled order — index i is wire signature slot i. */
  requiredSigners: string[];
}

/**
 * The pure, offline builders `op=prepare` drives. No RPC, no signer, no spend —
 * see the module header for why this is a separate seam from `ArnsBuySdk`.
 */
export interface ArnsPrepareDeps {
  /** The ario-ant program id for the target cluster. */
  antProgramId: string;
  /** MPL Core's program id, as the installed ar.io contracts package sees it. */
  mplCoreProgramId: string;
  /** Default root-record target when the caller names none (the AR.IO logo). */
  defaultTarget: string;
  /**
   * MPL Core `CreateV1` in the AR.IO ANT shape — Attributes plugin
   * pre-installed under Owner authority — with `payer` separable from
   * `authority`. That separation is the whole reason this op can exist.
   */
  buildCreateAntInstruction(args: {
    mint: string;
    authority: string;
    payer: string;
    name: string;
    uri: string;
    antProgramId: string;
  }): PreparedInstruction;
  /** `ario_ant::initialize` for a freshly minted asset (owner funds the PDAs). */
  buildInitializeAntInstruction(args: {
    mint: string;
    owner: string;
    name: string;
    ticker: string | null;
    target: string;
  }): Promise<PreparedInstruction>;
  /**
   * Byte sizes of every account a spawn creates, for a name of this length:
   * `[asset, AntConfig, AntControllers, root '@' record]`. The head is funded
   * through CreateV1's payer slot; the tail is the owner's, hence the transfer.
   */
  spawnAccountBytes(nameLength: number): number[];
  /** Compile an unsigned v0 message with a FOREIGN fee payer. */
  compileUnsigned(args: {
    feePayer: string;
    recentBlockhash: string;
    instructions: PreparedInstruction[];
  }): CompiledUnsignedTransaction;
}

/** Loader seam (tests inject a stub; defaults to the lazy import). */
export type LoadArnsPrepareDeps = (options: {
  network: ArnsNetwork;
}) => Promise<ArnsPrepareDeps>;

interface RawArioModule {
  getAntRecordPDA?: (
    mint: string,
    undername: string,
    programId: string
  ) => Promise<[string, number]>;
  spawnAntAccountBytes?: (nameLength: number) => number[];
  ARIO_LOGO_TX_ID?: string;
  ARIO_ANT_PROGRAM_ID?: string;
  DEVNET_PROGRAM_IDS?: { ant?: string };
}

/**
 * Default {@link LoadArnsPrepareDeps}: lazily import `@ar.io/sdk` (for the PDA
 * derivation and the account-size table), `@ar.io/solana-contracts` (for the
 * codama instruction builders) and `@solana/kit` (for message compilation).
 * Variable specifiers, matching `defaultLoadArnsBuySdk`'s style.
 *
 * NOTE on `@ar.io/solana-contracts`: the ergonomic wrapper for the first
 * builder — `buildCreateAntInstruction`, which exists in `@ar.io/sdk`'s source
 * precisely for "bundling the mint into a larger compound transaction" — is not
 * re-exported from that package's index, and its `exports` map rejects the deep
 * path. So we reproduce its ~20-line body against the codama builder directly.
 * `@ar.io/solana-contracts` is pinned EXACT to `@ar.io/sdk`'s own dependency:
 * a second copy would mean a divergent codama layout and a divergent default
 * program address.
 */
export const defaultLoadArnsPrepareDeps: LoadArnsPrepareDeps = async (
  options
) => {
  const sdkSpecifier = '@ar.io/sdk' as string;
  const coreSpecifier = '@ar.io/solana-contracts/mpl-core' as string;
  const antSpecifier = '@ar.io/solana-contracts/ant' as string;
  const kitSpecifier = '@solana/kit' as string;

  let mod: RawArioModule;
  let core: Record<string, unknown>;
  let ant: Record<string, unknown>;
  let kit: Record<string, unknown>;
  try {
    [mod, core, ant, kit] = (await Promise.all([
      import(sdkSpecifier),
      import(coreSpecifier),
      import(antSpecifier),
      import(kitSpecifier),
    ])) as unknown as [
      RawArioModule,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
  } catch (err) {
    throw new Error(
      'kind:5095 op=prepare needs `@ar.io/sdk`, `@ar.io/solana-contracts` ' +
        `and \`@solana/kit\`: ${err instanceof Error ? err.message : err}`
    );
  }

  const getAntRecordPDA = mod.getAntRecordPDA;
  const spawnAntAccountBytes = mod.spawnAntAccountBytes;
  const getCreateV1Instruction = core['getCreateV1Instruction'] as
    | ((args: unknown) => PreparedInstruction)
    | undefined;
  const dataState = core['DataState'] as { AccountState?: unknown } | undefined;
  const getInitializeInstructionAsync = ant['getInitializeInstructionAsync'] as
    | ((args: unknown, config: unknown) => Promise<PreparedInstruction>)
    | undefined;
  const mplCoreProgramId = core['MPL_CORE_PROGRAM_ADDRESS'] as
    | string
    | undefined;

  if (
    !getAntRecordPDA ||
    !spawnAntAccountBytes ||
    !getCreateV1Instruction ||
    !getInitializeInstructionAsync ||
    dataState?.AccountState === undefined ||
    mplCoreProgramId === undefined
  ) {
    throw new Error(
      'the installed @ar.io/sdk / @ar.io/solana-contracts expose an ' +
        'incompatible API surface for kind:5095 op=prepare (need ' +
        'getAntRecordPDA + spawnAntAccountBytes + getCreateV1Instruction + ' +
        'getInitializeInstructionAsync)'
    );
  }

  const antProgramId =
    options.network === 'devnet'
      ? mod.DEVNET_PROGRAM_IDS?.ant
      : mod.ARIO_ANT_PROGRAM_ID;
  if (antProgramId === undefined) {
    throw new Error(
      `the installed @ar.io/sdk exposes no ario-ant program id for ` +
        `${options.network}`
    );
  }
  const defaultTarget = mod.ARIO_LOGO_TX_ID;
  if (defaultTarget === undefined) {
    throw new Error('the installed @ar.io/sdk exposes no ARIO_LOGO_TX_ID');
  }

  const address = kit['address'] as (a: string) => string;
  const compile = makeKitCompiler(kit);

  /**
   * Minimal `TransactionSigner` shim. Not cosmetic: codama marks an account
   * meta SIGNER only when it receives a signer-SHAPED object, so passing a
   * bare address here compiles the payer to a non-signer meta and it lands
   * outside the one MPL Core slot the gas station permits.
   */
  const signerShim = (a: string) => ({
    address: address(a),
    signTransactions: async () => [],
  });

  return {
    antProgramId,
    mplCoreProgramId,
    defaultTarget,

    buildCreateAntInstruction: (args) =>
      getCreateV1Instruction({
        asset: signerShim(args.mint),
        payer: signerShim(args.payer),
        authority: signerShim(args.authority),
        // Load-bearing, and the reason this whole flow works. MPL Core defaults
        // an unset `owner` to the PAYER — which here is the gas station, not
        // the client. `spawnSolanaANT` never has to say it because there payer
        // and authority are the same signer; splitting them, which is the
        // entire point of this op, makes the default catastrophic: every ANT
        // would be minted into the gas wallet. Devnet simulation caught it as
        // `ario_ant::initialize` failing NotNftHolder, one instruction later.
        owner: address(args.authority),
        dataState: dataState.AccountState,
        name: args.name,
        uri: args.uri,
        // Always emit the Attributes plugin, even empty-valued: ArNS purchase
        // CPIs into UpdatePluginV1 to populate traits, and an asset without
        // the plugin returns MPL Core 0x4 "Plugin not found" at buy time. The
        // 'ANT Program' entry names the managing program on the asset itself
        // (ADR-016/BD-100) so a resolver needs no registry lookup.
        plugins: [
          {
            plugin: {
              __kind: 'Attributes',
              fields: [
                {
                  attributeList: [
                    { key: 'ANT Program', value: args.antProgramId },
                  ],
                },
              ],
            },
            authority: { __kind: 'Owner' },
          },
        ],
      }),

    buildInitializeAntInstruction: async (args) => {
      // AntConfig and AntControllers are codama-auto-derived; the root record
      // uses a hashed-undername seed codama cannot infer, so derive it here.
      const [rootRecord] = await getAntRecordPDA(args.mint, '@', antProgramId);
      return getInitializeInstructionAsync(
        {
          asset: address(args.mint),
          rootRecord,
          owner: signerShim(args.owner),
          name: args.name,
          ticker: args.ticker,
          target: args.target,
          targetProtocol: null,
          logo: '',
          description: '',
          keywords: [],
        },
        { programAddress: antProgramId }
      );
    },

    spawnAccountBytes: (nameLength) => spawnAntAccountBytes(nameLength),

    compileUnsigned: compile,
  };
};

/** Build the `compileUnsigned` implementation over a loaded `@solana/kit`. */
function makeKitCompiler(
  kit: Record<string, unknown>
): ArnsPrepareDeps['compileUnsigned'] {
  const address = kit['address'] as (a: string) => string;
  const pipe = kit['pipe'] as (v: unknown, ...fns: unknown[]) => unknown;
  const createTransactionMessage = kit['createTransactionMessage'] as (a: {
    version: 0;
  }) => unknown;
  const setFeePayer = kit['setTransactionMessageFeePayer'] as (
    a: string,
    m: unknown
  ) => unknown;
  const setLifetime = kit['setTransactionMessageLifetimeUsingBlockhash'] as (
    a: unknown,
    m: unknown
  ) => unknown;
  const appendInstructions = kit['appendTransactionMessageInstructions'] as (
    ix: unknown,
    m: unknown
  ) => unknown;
  const compileTransaction = kit['compileTransaction'] as (m: unknown) => {
    signatures: Record<string, unknown>;
  };
  const getWire = kit['getBase64EncodedWireTransaction'] as (
    tx: unknown
  ) => string;

  return ({ feePayer, recentBlockhash, instructions }) => {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m: unknown) => setFeePayer(address(feePayer), m),
      // `lastValidBlockHeight` is NOT serialized into the compiled message —
      // only the 32 blockhash bytes are — so a zero here cannot reach the wire.
      // That matters: the gas station's quote returns a blockhash and no
      // height, and there is nowhere honest to get one without an RPC call.
      (m: unknown) =>
        setLifetime({ blockhash: recentBlockhash, lastValidBlockHeight: 0n }, m),
      (m: unknown) => appendInstructions(instructions, m)
    );
    const tx = compileTransaction(message);
    return {
      wireBase64: getWire(tx),
      // Compiled signer order: fee payer, then writable signers, then readonly.
      requiredSigners: Object.keys(tx.signatures),
    };
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** The JSON receipt encoded (base64) into an accepted prepare job's `data`. */
export interface ArnsAntPrepareReceipt {
  job: 'arns-buy';
  op: 'prepare';
  network: ArnsNetwork;
  /**
   * The ANT's MPL Core asset pubkey — hand this back as
   * `['param','processId',…]` on the follow-up `op=buy`. Same value as `mint`,
   * named twice on purpose: one names what the BUY wants, the other names the
   * keypair the CLIENT signs with, and collapsing them would read as if a
   * client signs with a process id.
   */
  processId: string;
  mint: string;
  owner: string;
  feePayer: string;
  name: string;
  antProgramId: string;
  /** Base64 v0 wire transaction, UNSIGNED. Sign in place; do NOT recompile. */
  transaction: string;
  recentBlockhash: string;
  /** True ⇒ built on the placeholder blockhash: quote with it, never execute it. */
  draft: boolean;
  /** Signers in compiled order — index i is wire signature slot i. */
  requiredSigners: string[];
  /** The subset the CLIENT must sign before the gas station will accept it. */
  clientSigners: string[];
  /** Lamports the fee payer transfers to `owner` to cover the ANT state PDAs. */
  rentTransferLamports: string;
  /** Transfer + asset rent + a signature pad — what the delta cap must clear. */
  estimatedFeePayerLamports: string;
  instructions: string[];
}

/** Rent-exempt lamports for a set of to-be-created account sizes. */
export function rentLamports(accountBytes: number[]): bigint {
  const total = accountBytes.reduce(
    (sum, bytes) => sum + bytes + RENT_ACCOUNT_OVERHEAD_BYTES,
    0
  );
  return BigInt(total * LAMPORTS_PER_BYTE_YEAR);
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * `ComputeBudget::SetComputeUnitLimit`. Hand-encoded rather than pulling in
 * `@solana-program/compute-budget` for five bytes — and hand-encoding is what
 * lets the tests pin the exact bytes the gas station's inspector decodes.
 *
 * Note what is NOT here: `SetComputeUnitPrice`. The gas station's priority-fee
 * cap only engages when a price instruction is present, so omitting one skips
 * that check entirely instead of racing a fee estimator against a 200k ceiling.
 */
function computeUnitLimitInstruction(units: number): PreparedInstruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: concatBytes(new Uint8Array([2]), u32le(units)),
  };
}

/** `System::Transfer`. Discriminator 2, then a u64 of lamports. */
function systemTransferInstruction(
  from: string,
  to: string,
  lamports: bigint
): PreparedInstruction {
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: from, role: 3 /* WRITABLE_SIGNER */ },
      { address: to, role: 1 /* WRITABLE */ },
    ],
    data: concatBytes(u32le(2), u64le(lamports)),
  };
}

/** A rough per-signature fee pad, so the quote is not shaved to the lamport. */
const LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * Compose the unsigned ANT-spawn transaction. Pure: every input is a parameter
 * and every builder arrives through {@link ArnsPrepareDeps}, so the tests drive
 * it with the REAL builders, offline, and assert on the compiled bytes.
 *
 * Deterministic — two calls with the same params differ only in the 32
 * blockhash bytes, which is what lets a client quote a draft and then re-prepare
 * (or patch) against the quoted blockhash and get the same transaction.
 */
export async function buildAntSpawnTransaction(
  params: ArnsAntPrepareParams,
  deps: ArnsPrepareDeps,
  network: ArnsNetwork
): Promise<ArnsAntPrepareReceipt> {
  const instructions: PreparedInstruction[] = [
    computeUnitLimitInstruction(SPAWN_COMPUTE_UNIT_LIMIT),
  ];
  const names: string[] = ['compute-budget-limit'];

  // [asset, AntConfig, AntControllers, root '@'] — the head is the payer's
  // (CreateV1 CPIs its rent), the tail is the owner's (initialize has no
  // payer account), which is exactly the split the transfer below bridges.
  const [assetBytes, ...pdaBytes] = deps.spawnAccountBytes(params.name.length);

  let rentTransfer = 0n;
  if (params.initializeAnt) {
    rentTransfer = rentLamports(pdaBytes);
    instructions.push(
      systemTransferInstruction(params.feePayer, params.owner, rentTransfer)
    );
    names.push('system-transfer');
  }

  instructions.push(
    deps.buildCreateAntInstruction({
      mint: params.mint,
      authority: params.owner,
      payer: params.feePayer,
      name: params.name,
      uri: `ar://${params.target}`,
      antProgramId: deps.antProgramId,
    })
  );
  names.push('mpl-core-create-v1');

  if (params.initializeAnt) {
    instructions.push(
      await deps.buildInitializeAntInstruction({
        mint: params.mint,
        owner: params.owner,
        name: params.name,
        ticker: params.ticker,
        target: params.target,
      })
    );
    names.push('ario-ant-initialize');
  }

  const compiled = deps.compileUnsigned({
    feePayer: params.feePayer,
    recentBlockhash: params.recentBlockhash,
    instructions,
  });

  // The asset account's rent is CPI'd out of the CreateV1 payer slot, so it
  // never appears as a transfer — but the gas station's simulated lamport
  // delta sees it, and the quote must clear it.
  const assetRent = rentLamports(assetBytes === undefined ? [] : [assetBytes]);
  const signaturePad =
    BigInt(compiled.requiredSigners.length) * LAMPORTS_PER_SIGNATURE;

  return {
    job: 'arns-buy',
    op: 'prepare',
    network,
    processId: params.mint,
    mint: params.mint,
    owner: params.owner,
    feePayer: params.feePayer,
    name: params.name,
    antProgramId: deps.antProgramId,
    transaction: compiled.wireBase64,
    recentBlockhash: params.recentBlockhash,
    draft: params.draft,
    requiredSigners: compiled.requiredSigners,
    clientSigners: compiled.requiredSigners.filter(
      (signer) => signer !== params.feePayer
    ),
    rentTransferLamports: rentTransfer.toString(),
    estimatedFeePayerLamports: (
      rentTransfer +
      assetRent +
      signaturePad
    ).toString(),
    instructions: names,
  };
}
