/**
 * ArNS brokered name purchase — the "buyfor" job (NIP-90 kind:5095).
 *
 * The store already sells one thing (kind:5094: "put these bytes on Arweave").
 * This handler sells a second: "buy this ArNS name FOR me". The client cannot
 * (or does not want to) hold $ARIO; the DVM holds a funded Solana wallet and
 * executes `buyRecord` on the ar.io registry program on the client's behalf.
 *
 * OWNERSHIP MODEL (ADR-016 / BD-095/096 — non-holder buys): the job carries the
 * CLIENT's ANT `processId` (the MPL Core asset pubkey the client spawned and
 * owns via `ANT.spawn`). `buyRecord({ name, …, processId })` associates the
 * purchased name with that ANT, so the client owns the name from inception —
 * the DVM is only the payer, never the owner. Because the buyer is not the ANT
 * holder, the ANT NFT's Attributes plugin is left unpopulated by the purchase;
 * the handler attempts the `syncAttributes(name)` reconcile afterwards
 * (best-effort — a sync failure never fails a completed buy). NOTE, proven
 * live on devnet 2026-07-17: the deployed `ario-ant` program gates
 * SyncAttributes to the NFT HOLDER (AnchorError 6026 NotNftHolder,
 * lib.rs:1603), so the DVM's attempt fails benignly and the receipt carries
 * `syncAttributesTxId: null` — the CLIENT (holder) runs the reconcile itself.
 * The attempt is kept for deployments where the reconcile is permissionless.
 *
 * PAYMENT: like kind:5094, this backend is payment-oblivious. The connector in
 * front terminates the ILP payment (RouteTermination) and forwards the plain
 * HTTP job with the trusted X-TOON-* headers. Price the route >= the name cost:
 * the handler quotes `getTokenCost` (a free signerless read) per job and
 * surfaces the quote in the result so operators can reconcile route pricing.
 *
 * NETWORK SAFETY: defaults to Solana DEVNET (the SDK's DEVNET_PROGRAM_IDS).
 * Mainnet must be opted into explicitly via ARNS_NETWORK=mainnet.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type {
  StoreHandlerContext,
  StoreHandlerResponse,
} from './store-backend.js';

/** The NIP-90 job kind for a brokered ArNS name purchase. */
export const ARNS_BUY_KIND = 5095;

/** A name registration kind: a time-boxed lease or a one-time permabuy. */
export type ArnsNameType = 'lease' | 'permabuy';

/** Which cluster's ar.io deployment to target (no testnet — ar.io has none). */
export type ArnsNetwork = 'mainnet' | 'devnet';

/** Parsed, validated job parameters (from the event's `param` tags). */
export interface ArnsBuyParams {
  /** The ArNS name to register (1–51 chars, lowercase alnum + hyphens). */
  name: string;
  /** Registration kind. */
  type: ArnsNameType;
  /** Lease length in years (lease only; 1–5). */
  years?: number;
  /**
   * The CLIENT's ANT process id (MPL Core asset pubkey, base58). The bought
   * name is associated with this ANT, so the client owns it from inception.
   */
  processId: string;
}

/**
 * The slice of `@ar.io/sdk` the buy job drives, behind a seam so unit tests
 * inject a stub and NEVER touch the live registry (no real $ARIO is ever
 * spent by tests).
 */
export interface ArnsBuySdk {
  /** Quote the mARIO cost of the Buy-Name intent (free signerless read). */
  getTokenCost(args: {
    intent: 'Buy-Name';
    name: string;
    type: ArnsNameType;
    years?: number;
  }): Promise<bigint>;
  /**
   * Register (buy) the name with the DVM's funded signer, associated with the
   * client's ANT `processId`. Returns the settling registry tx signature.
   */
  buyRecord(args: {
    name: string;
    type: ArnsNameType;
    years?: number;
    processId: string;
  }): Promise<{ id: string }>;
  /**
   * Permissionless reconcile of the ANT NFT's Attributes plugin after a
   * non-holder buy (ADR-016). Best-effort from the handler's perspective.
   */
  syncAttributes(args: { name: string }): Promise<{ id: string }>;
}

/** Options the {@link LoadArnsBuySdk} seam needs to build a targeted SDK. */
export interface LoadArnsBuySdkOptions {
  network: ArnsNetwork;
  /** 64-byte Ed25519 Solana keypair (secretKey ‖ publicKey) — the DVM payer. */
  solanaSecretKey: Uint8Array;
}

/** Build a network-targeted {@link ArnsBuySdk} (tests inject a stub). */
export type LoadArnsBuySdk = (
  options: LoadArnsBuySdkOptions
) => Promise<ArnsBuySdk>;

/** Public Solana RPC fallbacks when the SDK exports none. */
const SOLANA_MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com';
const SOLANA_DEVNET_RPC_URL = 'https://api.devnet.solana.com';

/** Untyped shape of the optional modules the default loader reaches for. */
interface RawArioModule {
  ARIO?: { init?: (config: unknown) => RawArioInstance };
  DEFAULT_SOLANA_RPC_URL?: string;
  MAINNET_RPC_URL?: string;
  DEVNET_RPC_URL?: string;
  DEVNET_PROGRAM_IDS?: {
    core?: string;
    gar?: string;
    arns?: string;
    ant?: string;
  };
}
interface RawArioInstance {
  getTokenCost: (args: unknown) => Promise<unknown>;
  buyRecord?: (args: unknown) => Promise<unknown>;
  syncAttributes?: (args: unknown) => Promise<unknown>;
}
interface RawSolanaKitModule {
  createSolanaRpc?: (url: string) => unknown;
  createSolanaRpcSubscriptions?: (url: string) => unknown;
  createKeyPairSignerFromBytes?: (bytes: Uint8Array) => Promise<unknown>;
}

/**
 * Default {@link LoadArnsBuySdk}: lazily import `@ar.io/sdk` + `@solana/kit`
 * (variable specifiers so esbuild leaves them dynamic — both are marked
 * external in esbuild.config.mjs) and build a WRITE client from the DVM's
 * keypair: `createSolanaRpc` + `createSolanaRpcSubscriptions` + a
 * `createKeyPairSignerFromBytes` signer, with `DEVNET_PROGRAM_IDS` overrides
 * off mainnet (the #376-proven wiring — @ar.io/sdk >= 4.0.3 builds no default
 * transport itself).
 */
export const defaultLoadArnsBuySdk: LoadArnsBuySdk = async (options) => {
  const sdkSpecifier = '@ar.io/sdk' as string;
  const kitSpecifier = '@solana/kit' as string;
  let mod: RawArioModule;
  let kit: RawSolanaKitModule;
  try {
    mod = (await import(sdkSpecifier)) as unknown as RawArioModule;
    kit = (await import(kitSpecifier)) as unknown as RawSolanaKitModule;
  } catch (err) {
    throw new Error(
      'kind:5095 ArNS buy needs the optional `@ar.io/sdk` (+ `@solana/kit`) ' +
        `dependency: ${err instanceof Error ? err.message : err}`
    );
  }
  const arioInit = mod.ARIO?.init;
  const { createSolanaRpc, createSolanaRpcSubscriptions } = kit;
  const createSigner = kit.createKeyPairSignerFromBytes;
  if (
    !arioInit ||
    !createSolanaRpc ||
    !createSolanaRpcSubscriptions ||
    !createSigner
  ) {
    throw new Error(
      'the installed @ar.io/sdk / @solana/kit expose an incompatible API ' +
        'surface for kind:5095 (need ARIO.init + the @solana/kit factories; ' +
        '@ar.io/sdk >= 4.0.3)'
    );
  }

  const rpcUrl =
    options.network === 'devnet'
      ? (mod.DEVNET_RPC_URL ?? SOLANA_DEVNET_RPC_URL)
      : (mod.DEFAULT_SOLANA_RPC_URL ??
        mod.MAINNET_RPC_URL ??
        SOLANA_MAINNET_RPC_URL);
  const devnetIds =
    options.network === 'devnet' ? mod.DEVNET_PROGRAM_IDS : undefined;
  if (options.network === 'devnet' && devnetIds === undefined) {
    throw new Error(
      'the installed @ar.io/sdk exposes no DEVNET_PROGRAM_IDS — devnet ' +
        "targeting needs the SDK's staging program ids"
    );
  }
  const ario = arioInit({
    rpc: createSolanaRpc(rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(
      rpcUrl.replace(/^http/, 'ws')
    ),
    signer: await createSigner(options.solanaSecretKey),
    ...(devnetIds?.core !== undefined ? { coreProgramId: devnetIds.core } : {}),
    ...(devnetIds?.gar !== undefined ? { garProgramId: devnetIds.gar } : {}),
    ...(devnetIds?.arns !== undefined ? { arnsProgramId: devnetIds.arns } : {}),
    ...(devnetIds?.ant !== undefined ? { antProgramId: devnetIds.ant } : {}),
  });

  return {
    getTokenCost: async (args) => BigInt(String(await ario.getTokenCost(args))),
    buyRecord: async (args) => {
      if (typeof ario.buyRecord !== 'function') {
        throw new Error('the signed ARIO client exposes no buyRecord');
      }
      return (await ario.buyRecord(args)) as { id: string };
    },
    syncAttributes: async (args) => {
      if (typeof ario.syncAttributes !== 'function') {
        throw new Error('the signed ARIO client exposes no syncAttributes');
      }
      return (await ario.syncAttributes(args)) as { id: string };
    },
  };
};

// ---------------------------------------------------------------------------
// Param parsing
// ---------------------------------------------------------------------------

/** ArNS name rule: 1–51 chars, lowercase alnum + hyphens, no edge hyphens. */
const ARNS_NAME_REGEX = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,49}[a-z0-9])$/;
/** Base58 Solana pubkey (the client ANT's MPL Core asset address). */
const SOLANA_PUBKEY_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_LEASE_YEARS = 5;

/** First value of a NIP-90 `['param', <key>, <value>]` tag, if present. */
function paramTag(event: NostrEvent, key: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === 'param' && tag[1] === key) return tag[2];
  }
  return undefined;
}

/**
 * Parse + validate the kind:5095 job params from the event's `param` tags:
 * `name` (required), `processId` (required — the client's ANT), `type`
 * (default `lease`), `years` (lease only, default 1, max {@link MAX_LEASE_YEARS}).
 *
 * @throws {Error} with a client-actionable message on any invalid param.
 */
export function parseArnsBuyParams(event: NostrEvent): ArnsBuyParams {
  const name = paramTag(event, 'name');
  if (!name) throw new Error("missing required param tag: ['param','name',…]");
  if (!ARNS_NAME_REGEX.test(name)) {
    throw new Error(
      `invalid ArNS name ${JSON.stringify(name)} — 1–51 lowercase ` +
        'alphanumeric/hyphen chars, no leading/trailing hyphen'
    );
  }

  const processId = paramTag(event, 'processId');
  if (!processId) {
    throw new Error(
      "missing required param tag: ['param','processId',…] — the client's " +
        'ANT (MPL Core asset) pubkey; spawn one with ANT.spawn first'
    );
  }
  if (!SOLANA_PUBKEY_REGEX.test(processId)) {
    throw new Error(
      `invalid processId ${JSON.stringify(processId)} — expected a base58 ` +
        'Solana pubkey'
    );
  }

  const typeRaw = paramTag(event, 'type') ?? 'lease';
  if (typeRaw !== 'lease' && typeRaw !== 'permabuy') {
    throw new Error(
      `invalid type ${JSON.stringify(typeRaw)} — expected lease | permabuy`
    );
  }
  const type: ArnsNameType = typeRaw;

  const yearsRaw = paramTag(event, 'years');
  if (type === 'permabuy') {
    if (yearsRaw !== undefined) {
      throw new Error('years is not valid for a permabuy');
    }
    return { name, type, processId };
  }
  const years = yearsRaw === undefined ? 1 : Number(yearsRaw);
  if (!Number.isInteger(years) || years < 1 || years > MAX_LEASE_YEARS) {
    throw new Error(
      `invalid years ${JSON.stringify(yearsRaw)} — expected an integer ` +
        `1–${MAX_LEASE_YEARS}`
    );
  }
  return { name, type, years, processId };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Configuration for {@link createArnsBuyHandler}. */
export interface ArnsBuyConfig {
  /** Which cluster's ar.io deployment the DVM buys on. */
  network: ArnsNetwork;
  /** 64-byte Ed25519 Solana keypair of the DVM's funded payer wallet. */
  solanaSecretKey: Uint8Array;
  /** SDK loader seam (tests inject a stub; defaults to the lazy import). */
  loadSdk?: LoadArnsBuySdk;
}

/** The JSON receipt encoded (base64) into an accepted job's `data`. */
export interface ArnsBuyReceipt {
  job: 'arns-buy';
  network: ArnsNetwork;
  name: string;
  type: ArnsNameType;
  years: number | null;
  /** The client's ANT process id the name was associated with (the owner). */
  processId: string;
  /** The quoted Buy-Name cost the DVM paid, in mARIO base units. */
  quotedMario: string;
  /** Registry transaction signature of the executed buy. */
  registryTxId: string;
  /** `syncAttributes` reconcile tx signature; null when the sync failed. */
  syncAttributesTxId: string | null;
}

/**
 * Build the kind:5095 handler. The SDK is loaded lazily on the first job (and
 * cached), so a store booted with the job enabled but never asked to buy pays
 * no import cost — and a broken optional install surfaces per-job as a clean
 * rejection instead of a boot failure.
 */
export function createArnsBuyHandler(
  config: ArnsBuyConfig
): (ctx: StoreHandlerContext) => Promise<StoreHandlerResponse> {
  let sdkPromise: Promise<ArnsBuySdk> | undefined;
  const loadSdk = config.loadSdk ?? defaultLoadArnsBuySdk;
  const getSdk = () => {
    sdkPromise ??= loadSdk({
      network: config.network,
      solanaSecretKey: config.solanaSecretKey,
    }).catch((err: unknown) => {
      // Let a later job retry (e.g. after the operator fixes the install).
      sdkPromise = undefined;
      throw err;
    });
    return sdkPromise;
  };

  return async (ctx) => {
    const event = ctx.decode();
    if (event.kind !== ARNS_BUY_KIND) {
      return ctx.reject(
        'F00',
        `arns-buy handler received kind:${event.kind}, expected kind:${ARNS_BUY_KIND}`
      );
    }

    let params: ArnsBuyParams;
    try {
      params = parseArnsBuyParams(event);
    } catch (err) {
      return ctx.reject('F00', err instanceof Error ? err.message : String(err));
    }

    try {
      const sdk = await getSdk();

      // Quote first (free read) so the receipt records what the buy cost.
      const quotedMario = await sdk.getTokenCost({
        intent: 'Buy-Name',
        name: params.name,
        type: params.type,
        ...(params.years !== undefined ? { years: params.years } : {}),
      });

      // The buy: DVM signer pays, the client's ANT (processId) owns.
      const receipt = await sdk.buyRecord({
        name: params.name,
        type: params.type,
        ...(params.years !== undefined ? { years: params.years } : {}),
        processId: params.processId,
      });

      // Non-holder buy leaves the ANT NFT's traits unpopulated — run the
      // permissionless reconcile, but never fail a completed buy over it.
      let syncAttributesTxId: string | null = null;
      try {
        syncAttributesTxId = (await sdk.syncAttributes({ name: params.name }))
          .id;
      } catch (err) {
        console.warn(
          `[store] arns-buy: syncAttributes failed for "${params.name}" ` +
            `(non-fatal; re-run it permissionlessly): ` +
            `${err instanceof Error ? err.message : err}`
        );
      }

      const result: ArnsBuyReceipt = {
        job: 'arns-buy',
        network: config.network,
        name: params.name,
        type: params.type,
        years: params.years ?? null,
        processId: params.processId,
        quotedMario: quotedMario.toString(),
        registryTxId: receipt.id,
        syncAttributesTxId,
      };
      return {
        accept: true,
        data: Buffer.from(JSON.stringify(result), 'utf8').toString('base64'),
      };
    } catch (err) {
      return ctx.reject(
        'T00',
        `arns-buy failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
}
