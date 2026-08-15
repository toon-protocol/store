/**
 * x402 Arweave upload adapter: pays AR.IO's bundler PER UPLOAD in real USDC on
 * Base mainnet, instead of drawing down prepaid Turbo credits.
 *
 * WHY THIS EXISTS
 * ---------------
 * AR.IO's upload service is a live x402 merchant: an upload above the free tier
 * is answered with HTTP 402 carrying x402 payment requirements (scheme `exact`,
 * network `base`, asset = canonical native USDC `0x8335…2913`, payTo
 * `0x6A0A…Bf67`). TOON positions as the x402 *facilitator* layer, so a TOON node
 * paying that merchant over x402 is two live systems speaking one protocol
 * rather than a bespoke integration.
 *
 * WHY IT DOES NOT USE turbo-sdk's OWN x402 PATH
 * ---------------------------------------------
 * `@ardrive/turbo-sdk@1.40.2`–`1.42.0` ships `uploadRawX402Data` /
 * `makeX402Signer`, but that path cannot work against the live service today:
 *
 *   1. `uploadRawX402Data` posts to `/x402/data-item/unsigned`, which 404s on
 *      both `upload.ardrive.io` and `upload.services.ar.io`. The live route is
 *      `/v1/tx`. This fires before signing, so it masks (2) entirely.
 *      → https://github.com/ardriveapp/turbo-sdk/issues/440
 *   2. `makeX402Signer` hardcodes `chain: baseSepolia` in both branches while
 *      the live service demands `network: "base"` (Base mainnet).
 *      → https://github.com/ardriveapp/turbo-sdk/issues/441
 *
 * So this adapter builds the ANS-104 data item itself (`@dha-team/arbundles`
 * `createData` + `ArweaveSigner`) and POSTs the raw item to `/v1/tx` through
 * `wrapFetchWithPayment`, choosing the endpoint and the chain explicitly. Both
 * upstream defects are routed around rather than patched. When AR.IO fixes
 * them, this collapses to a call to their SDK.
 *
 * TWO KEYS, TWO JOBS. Do not conflate them:
 *   - the Arweave RSA JWK SIGNS the data item (authorship / ownership)
 *   - the EVM key PAYS for it in USDC (settlement)
 * The JWK needs no Turbo credits on this path; the EVM key needs no ETH,
 * because x402 `exact` over USDC is EIP-3009 `transferWithAuthorization` and is
 * signed off-chain.
 *
 * FREE TIER STILL APPLIES. `wrapFetchWithPayment` pays only when the server
 * actually answers 402, so an upload under AR.IO's ~100 KB free-tier grant
 * costs nothing and still succeeds. This adapter therefore spends money strictly
 * when the service asks for money.
 */

/** A signed ANS-104 data item, as returned by arbundles' `createData`. */
interface DataItemLike {
  readonly id: string;
  sign(signer: unknown): Promise<unknown>;
  getRaw(): Buffer;
}

/** The lazily-imported third-party surface this adapter needs. */
export interface X402UploadDeps {
  createData(
    data: Buffer,
    signer: unknown,
    opts?: { tags?: { name: string; value: string }[] }
  ): DataItemLike;
  ArweaveSigner: new (jwk: unknown) => unknown;
  wrapFetchWithPayment(
    f: typeof globalThis.fetch,
    signer: unknown,
    maxValue?: bigint
  ): (input: string, init?: RequestInit) => Promise<Response>;
  createSigner(network: string, privateKey: string): Promise<unknown>;
  decodeXPaymentResponse?(header: string): unknown;
}

export type LoadX402Deps = () => Promise<X402UploadDeps>;

/**
 * Load the optional x402 upload dependencies.
 *
 * Loaded lazily through a variable specifier, the same shape
 * `defaultLoadArnsBuySdk` uses for `@ar.io/sdk`, so esbuild keeps them
 * external and the store still boots on an image that lacks them. They ride in
 * transitively via `@ardrive/turbo-sdk`, and are pinned explicitly in
 * `Dockerfile.store` so that transitive arrival is not load-bearing.
 */
export const defaultLoadX402Deps: LoadX402Deps = async () => {
  const arbundlesSpecifier = '@dha-team/arbundles' as string;
  const x402FetchSpecifier = 'x402-fetch' as string;
  let arbundles: Partial<X402UploadDeps>;
  let x402Fetch: Partial<X402UploadDeps>;
  try {
    arbundles = (await import(arbundlesSpecifier)) as unknown as Partial<X402UploadDeps>;
    x402Fetch = (await import(x402FetchSpecifier)) as unknown as Partial<X402UploadDeps>;
  } catch (err) {
    throw new Error(
      'x402 uploads need the optional `@dha-team/arbundles` + `x402-fetch` ' +
        `dependencies: ${err instanceof Error ? err.message : err}`
    );
  }
  const { createData, ArweaveSigner } = arbundles;
  const { wrapFetchWithPayment, createSigner, decodeXPaymentResponse } = x402Fetch;
  if (!createData || !ArweaveSigner || !wrapFetchWithPayment || !createSigner) {
    throw new Error(
      'x402 upload dependencies resolved but are missing required exports ' +
        '(createData / ArweaveSigner / wrapFetchWithPayment / createSigner).'
    );
  }
  return {
    createData,
    ArweaveSigner,
    wrapFetchWithPayment,
    createSigner,
    decodeXPaymentResponse,
  };
};

export interface X402UploadConfig {
  /**
   * Parsed Arweave RSA JWK. SIGNS the data item; never pays for it. Turbo
   * credits on this wallet are irrelevant on the x402 path.
   */
  arweaveJwk: unknown;
  /** 0x-prefixed EVM private key holding USDC on `network`. PAYS for uploads. */
  evmPrivateKey: string;
  /** Bundler endpoint. Default `https://upload.services.ar.io/v1/tx`. */
  uploadUrl?: string;
  /** x402 network name. Default `base` (Base MAINNET, not baseSepolia). */
  network?: string;
  /**
   * Hard per-upload ceiling in USDC base units (6 dp). Default 100_000 =
   * $0.10, which covers the 2 MiB edge cap (~$0.06) with headroom while still
   * refusing a runaway quote. `wrapFetchWithPayment` enforces it.
   */
  maxPaymentBaseUnits?: bigint;
  /** Seam for tests. */
  loadDeps?: LoadX402Deps;
}

export const DEFAULT_X402_UPLOAD_URL = 'https://upload.services.ar.io/v1/tx';
export const DEFAULT_X402_NETWORK = 'base';
/** $0.10 in USDC base units. 2 MiB costs ~$0.061, so this is ~1.6x headroom. */
export const DEFAULT_X402_MAX_PAYMENT = 100_000n;

/**
 * Uploads to Arweave by paying AR.IO's bundler over x402.
 *
 * Structurally implements the SDK's `ArweaveUploadAdapter`
 * (`upload(data, tags) -> { txId }`), so it drops in wherever
 * `TurboUploadAdapter` goes. Deliberately NOT declared `implements
 * ArweaveUploadAdapter`, which would pull an `@toon-protocol/sdk` type import
 * into a module the entrypoint keeps dependency-light; the entrypoint's
 * assignment to `ArweaveDvmConfig.turboAdapter` is what type-checks the shape.
 */
export class X402UploadAdapter {
  private readonly loadDeps: LoadX402Deps;
  private ready?: Promise<{
    deps: X402UploadDeps;
    arweaveSigner: unknown;
    payFetch: (input: string, init?: RequestInit) => Promise<Response>;
  }>;

  constructor(private readonly config: X402UploadConfig) {
    this.loadDeps = config.loadDeps ?? defaultLoadX402Deps;
  }

  /**
   * Build the Arweave signer and the payment-wrapped fetch exactly once.
   * `createSigner` is async, so this cannot happen in the constructor; every
   * upload awaits the same promise.
   */
  private init() {
    if (!this.ready) {
      this.ready = (async () => {
        const deps = await this.loadDeps();
        const arweaveSigner = new deps.ArweaveSigner(this.config.arweaveJwk);
        const paymentSigner = await deps.createSigner(
          this.config.network ?? DEFAULT_X402_NETWORK,
          this.config.evmPrivateKey
        );
        const payFetch = deps.wrapFetchWithPayment(
          globalThis.fetch,
          paymentSigner,
          this.config.maxPaymentBaseUnits ?? DEFAULT_X402_MAX_PAYMENT
        );
        return { deps, arweaveSigner, payFetch };
      })();
      // A failed init must not poison the adapter forever, so drop the cached
      // promise so a later upload retries (e.g. transient DNS at boot).
      this.ready.catch(() => {
        this.ready = undefined;
      });
    }
    return this.ready;
  }

  async upload(data: Buffer, tags?: Record<string, string>): Promise<{ txId: string }> {
    const { deps, arweaveSigner, payFetch } = await this.init();

    const item = deps.createData(data, arweaveSigner, {
      tags: Object.entries(tags ?? {}).map(([name, value]) => ({ name, value })),
    });
    // `id` is only defined once the item is signed. Read it after, never before.
    await item.sign(arweaveSigner);
    const raw = item.getRaw();

    const url = this.config.uploadUrl ?? DEFAULT_X402_UPLOAD_URL;
    const res = await payFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw as unknown as RequestInit['body'],
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `x402 Arweave upload failed: HTTP ${res.status} from ${url}: ${body.slice(0, 400)}`
      );
    }

    // The receipt carries the canonical id and, importantly, `winc`. A receipt
    // with `winc: "0"` proves nothing was drawn from Turbo credits, i.e. this
    // really was the x402 path and not the prepaid one.
    let receiptId: string | undefined;
    let winc: string | undefined;
    try {
      const receipt = (await res.json()) as { id?: unknown; winc?: unknown };
      if (typeof receipt?.id === 'string' && receipt.id.length > 0) receiptId = receipt.id;
      if (receipt?.winc !== undefined) winc = String(receipt.winc);
    } catch {
      // A 2xx with an unparseable body still uploaded: the locally computed
      // data-item id is deterministic, so fall through to it.
    }

    const paymentHeader = res.headers.get('x-payment-response');
    let paid: unknown;
    if (paymentHeader && deps.decodeXPaymentResponse) {
      try {
        paid = deps.decodeXPaymentResponse(paymentHeader);
      } catch {
        paid = paymentHeader;
      }
    }
    console.log(
      `[store] x402 upload ok: txId=${receiptId ?? item.id} bytes=${raw.length}` +
        ` winc=${winc ?? '-'} paid=${paid ? JSON.stringify(paid) : 'free-tier (no 402)'}`
    );

    return { txId: receiptId ?? item.id };
  }
}

export interface ResolvedX402Env {
  evmPrivateKey: string;
  uploadUrl: string;
  network: string;
  maxPaymentBaseUnits: bigint;
  /** Where the key came from, for the boot banner. Never the key itself. */
  keySource: 'STORE_X402_EVM_KEY_FILE' | 'STORE_X402_EVM_KEY';
}

/**
 * Resolve x402 upload settings from the environment.
 *
 * Returns `undefined` when x402 is not configured, which is what keeps this
 * change inert for every existing deployment: no new env var, no behaviour
 * change. Throws only when the operator clearly INTENDED x402 but misconfigured
 * it. A silent fallback to prepaid credits would be a wrong-pocket surprise.
 */
export function resolveX402Env(
  env: NodeJS.ProcessEnv,
  readFile: (p: string) => string
): ResolvedX402Env | undefined {
  const keyFile = env['STORE_X402_EVM_KEY_FILE']?.trim() || undefined;
  const inlineKey = env['STORE_X402_EVM_KEY']?.trim() || undefined;
  if (!keyFile && !inlineKey) return undefined;

  let evmPrivateKey: string;
  const keySource: ResolvedX402Env['keySource'] = keyFile
    ? 'STORE_X402_EVM_KEY_FILE'
    : 'STORE_X402_EVM_KEY';
  if (keyFile) {
    try {
      evmPrivateKey = readFile(keyFile).trim();
    } catch (err) {
      throw new Error(
        `STORE_X402_EVM_KEY_FILE (${keyFile}) could not be read: ` +
          `${err instanceof Error ? err.message : err}`
      );
    }
  } else {
    evmPrivateKey = inlineKey as string;
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(evmPrivateKey)) {
    // Deliberately does not echo the value.
    throw new Error(
      `x402 EVM key from ${keySource} must be a 0x-prefixed 32-byte hex private key.`
    );
  }

  const uploadUrl = env['STORE_X402_UPLOAD_URL']?.trim() || DEFAULT_X402_UPLOAD_URL;
  const network = env['STORE_X402_NETWORK']?.trim() || DEFAULT_X402_NETWORK;

  let maxPaymentBaseUnits = DEFAULT_X402_MAX_PAYMENT;
  const rawMax = env['STORE_X402_MAX_PAYMENT']?.trim();
  if (rawMax) {
    let parsed: bigint;
    try {
      parsed = BigInt(rawMax);
    } catch {
      throw new Error('STORE_X402_MAX_PAYMENT must be an integer in USDC base units (6 dp).');
    }
    if (parsed <= 0n) {
      throw new Error('STORE_X402_MAX_PAYMENT must be greater than zero.');
    }
    maxPaymentBaseUnits = parsed;
  }

  return { evmPrivateKey, uploadUrl, network, maxPaymentBaseUnits, keySource };
}
