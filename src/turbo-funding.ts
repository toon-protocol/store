/**
 * Turbo funding for the store (store#123, reworked in review on store#128).
 *
 * The store pays for its storage PER UPLOAD, in $ARIO, at the moment of the
 * upload -- there is no standing credit balance, no background spender, and
 * therefore nothing to monitor. All of it is resolved at the upload-adapter
 * seam (the job handler keeps receiving an ArweaveUploadAdapter and knows
 * nothing about how an upload was paid for):
 *
 *  - EXPLICIT NETWORK SELECTION. Which Solana network, and therefore which
 *    $ARIO mint, is a stated configuration decision. turbo-sdk picks its mint
 *    by testing the gateway URL for the substring "devnet"; that inference is
 *    treated as an implementation detail not to be relied on, so the stated
 *    network and the configured gateway are cross-checked at boot and a
 *    mismatch refuses to start. The mint for each network is pinned here.
 *
 *  - THE FREE TIER IS A SIZE ROUTE, NOT A FALLBACK. Turbo uploads whose
 *    SIGNED data item fits the measured 107,520-byte free ceiling are free
 *    for any valid signer at any balance, including zero (verified on mainnet
 *    2026-08-29), but that allowance is finite: once a signer has used it the
 *    bundler answers 402 to items under the ceiling too. So the free tier is
 *    only for a store with no spend authority. A store with a spend ceiling
 *    pays for every upload, whatever its size; one without routes by that size
 *    and refuses what is over the ceiling.
 *
 *  - PAID UPLOADS ARE ON-DEMAND AND BOUNDED PER UPLOAD. turbo-sdk's
 *    OnDemandFunding prices the actual byte count, buys only the shortfall,
 *    and THROWS rather than spending above `maxTokenAmount` -- a per-upload
 *    bound that needs no memory of previous uploads. The bound is
 *    STORE_TURBO_MAX_ARIO_PER_UPLOAD, and setting it is what turns the paid
 *    route on, for every upload: unset, the store serves the free tier and
 *    refuses an above-ceiling upload BY NAME, so an operator can run a node
 *    with no spend authority at all. This also aligns cost with revenue: the
 *    connector charges the client per upload (ADR 0065 schedules), so the
 *    store pays per upload.
 *
 * Decision record: the balance monitor #128 first shipped (threshold,
 * timed top-ups, landed-transfer recovery) was reviewed away. The x402
 * per-upload path (#98) had the right SHAPE and the wrong token; this is that
 * shape in ar.io's own token.
 *
 * WHICH ACCOUNT: a Solana key has two Turbo accounts, and they differ. The
 * bundler debits the one keyed by the RAW SOLANA PUBKEY. turbo-sdk's
 * OnDemandFunding reads the balance of the sha256-shaped one, so credit on that
 * account stops it buying while the bundler answers 402 (mainnet, 2026-11-02:
 * 69.7B winc there, 15M on the pubkey, every upload refused; 920M winc sent to
 * the pubkey and a 23,565-byte upload went through, debiting only the pubkey).
 * So this module does not use OnDemandFunding: it reads and funds the pubkey
 * account itself.
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
 * cluster constants as of turbo-sdk 1.42.0 (what the lockfile resolves).
 */
export const ARIO_MINTS: Record<TurboSolanaNetwork, string> = {
  mainnet: 'DcNnMuFxwhgV4WY1HVSaSEgr92bv2b1vUvEKiNxWqHdF',
  devnet: '6vTw5CysRXQ4ybbHkDUiisHWVsBeMtUzYvJqs2iqHyaN',
};

export const ARIO_TOKEN_DECIMALS = 6;

/**
 * A gateway URL fit for an error message, a log line, or a health surface:
 * origin only. RPC providers (Helius, QuickNode) put the API key in the path
 * or query, and both the operator log and /health leave the box.
 */
export function redactGatewayUrl(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return '<unparseable URL>';
  }
}

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
      `STORE_TURBO_SOLANA_NETWORK is mainnet but STORE_TURBO_SOLANA_GATEWAY (${redactGatewayUrl(gatewayUrl)}) ` +
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
// The free-tier size route
// ---------------------------------------------------------------------------

/**
 * Turbo's measured per-item free ceiling: 107,520 bytes (105 KiB), read live
 * from upload.ardrive.io's own descriptor -- NOT the round "100 KB" prose
 * suggests. Below it, any valid signer uploads at any balance, including zero
 * (verified on mainnet 2026-08-29), so a store with no spend authority still
 * serves this tier.
 */
export const TURBO_FREE_TIER_MAX_BYTES = 107_520;

/**
 * Turbo applies the free-tier ceiling to the SIGNED ANS-104 DATA ITEM, not to
 * the payload: signature type (2) + signature + owner + target/anchor absence
 * flags (1+1) + tag count and byte-length longs (8+8) + the avro-encoded tag
 * block, then the payload. Comparing the payload alone leaves a hole exactly
 * one envelope wide at the boundary, where the size route would submit an
 * upload unfunded and Turbo would kill it as a generic failure.
 */
export type DataItemSignerKind = 'arweave-rsa' | 'solana-ed25519';

const DATA_ITEM_ENVELOPE_BYTES: Record<DataItemSignerKind, number> = {
  'arweave-rsa': 2 + 512 + 512 + 1 + 1 + 8 + 8, // 4096-bit RSA sig + owner
  'solana-ed25519': 2 + 64 + 32 + 1 + 1 + 8 + 8, // ed25519 sig + pubkey
};

/**
 * Estimated size of the signed data item for a payload. Tag block per avro's
 * encoding: a count long per array block, a length long per string, and the
 * UTF-8 bytes; longs are zigzag varints, bounded here at 2 bytes each for the
 * tag sizes a store upload carries, plus the terminating zero block.
 */
export function estimateDataItemBytes(
  payloadBytes: number,
  signerKind: DataItemSignerKind,
  tags?: Record<string, string>
): number {
  let tagBytes = 0;
  const entries = tags ? Object.entries(tags) : [];
  if (entries.length > 0) {
    tagBytes = 3; // block count + trailing zero block
    for (const [name, value] of entries) {
      tagBytes +=
        Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + 4;
    }
  }
  return DATA_ITEM_ENVELOPE_BYTES[signerKind] + tagBytes + payloadBytes;
}

// ---------------------------------------------------------------------------
// Per-upload spend authority
// ---------------------------------------------------------------------------

export interface TurboOnDemandEnvConfig {
  /**
   * Per-upload $ARIO ceiling handed to OnDemandFunding as `maxTokenAmount`.
   * Set = every upload takes the paid route, bounded at this much. Unset = the
   * store serves the free tier only and refuses above-ceiling uploads by name.
   */
  maxArioPerUpload?: number;
  paidUploadsEnabled: boolean;
}

/**
 * Resolve STORE_TURBO_MAX_ARIO_PER_UPLOAD. Setting it IS the spend
 * authorization; a malformed value throws rather than degrades (a box that
 * asked for paid uploads and silently got the free tier would refuse jobs it
 * was configured to serve).
 */
export function resolveTurboOnDemandEnv(
  env: NodeJS.ProcessEnv
): TurboOnDemandEnvConfig {
  const raw = env['STORE_TURBO_MAX_ARIO_PER_UPLOAD']?.trim();
  if (!raw) return { paidUploadsEnabled: false };
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `STORE_TURBO_MAX_ARIO_PER_UPLOAD must be a positive number of $ARIO, got ${JSON.stringify(raw)}`
    );
  }
  return { maxArioPerUpload: value, paidUploadsEnabled: true };
}

// ---------------------------------------------------------------------------
// The on-demand upload adapter
// ---------------------------------------------------------------------------

/**
 * The slice of a Turbo client the adapter needs (duck-typed; stubbed in
 * tests).
 */
export interface TurboOnDemandClient {
  upload(params: {
    data: Buffer;
    dataItemOpts?: { tags: { name: string; value: string }[] };
  }): Promise<{ id: string }>;
  getBalance(address: string): Promise<{ effectiveBalance: string }>;
  getUploadCosts(params: { bytes: number[] }): Promise<{ winc: string }[]>;
  getWincForToken(params: { tokenAmount: string }): Promise<{ winc: string }>;
  topUpWithTokens(params: {
    tokenAmount: string;
    turboCreditDestinationAddress: string;
  }): Promise<{ id: string }>;
}

interface AdapterLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Turbo's price can move between the quote and the upload; buy a little over the shortfall. */
const TOP_UP_BUFFER_PERCENT = 110n;
const ONE_ARIO = 10n ** BigInt(ARIO_TOKEN_DECIMALS);

/**
 * The store's ArweaveUploadAdapter. With `maxArioPerUpload` set, every upload
 * first makes sure `creditAccount` can pay for it, buying the shortfall in
 * $ARIO and refusing to spend above the bound. With none, route by the SIGNED
 * data item size: at or under the free ceiling the upload is submitted as it
 * is, and above it the upload is refused by name, so "no spend authority" and
 * "your blob is malformed" stay different messages, and the refusal happens
 * before any bytes reach Turbo.
 */
export function createOnDemandUploadAdapter(options: {
  client: TurboOnDemandClient;
  /** Sets the envelope size the free-tier ceiling is measured against. */
  signerKind: DataItemSignerKind;
  /** Per-upload $ARIO ceiling; undefined = paid route off. */
  maxArioPerUpload?: number;
  /** The signer's raw Solana pubkey: the account the bundler debits. */
  creditAccount?: string;
  log?: AdapterLogger;
  /** Test seam: how long to wait between balance reads after a top-up. */
  creditPollMs?: number;
}): ArweaveUploadAdapter {
  const { client, signerKind, maxArioPerUpload, creditAccount } = options;
  if (maxArioPerUpload !== undefined && !creditAccount) {
    throw new Error('a spend ceiling needs the creditAccount it pays into');
  }
  const log = options.log ?? {
    info: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
  };
  const creditPollMs = options.creditPollMs ?? 3_000;

  const creditFor = async (account: string, price: bigint, maxArio: number) => {
    const balance = BigInt((await client.getBalance(account)).effectiveBalance);
    if (balance >= price) return;

    const wincPerArio = BigInt(
      (await client.getWincForToken({ tokenAmount: ONE_ARIO.toString() })).winc
    );
    const winc = ((price - balance) * TOP_UP_BUFFER_PERCENT) / 100n;
    const tokenAmount = (winc * ONE_ARIO) / wincPerArio + 1n;
    const ceiling = BigInt(Math.floor(maxArio * Number(ONE_ARIO)));
    if (tokenAmount > ceiling) {
      throw new Error(
        `top-up of ${tokenAmount} $ARIO base units is over the ceiling of ${maxArio} $ARIO per upload`
      );
    }
    const { id } = await client.topUpWithTokens({
      tokenAmount: tokenAmount.toString(),
      turboCreditDestinationAddress: account,
    });
    log.info(`[store] bought ${tokenAmount} $ARIO base units of credit for ${account}: ${id}`);

    for (let attempt = 0; attempt < 40; attempt++) {
      const now = BigInt((await client.getBalance(account)).effectiveBalance);
      if (now >= price) return;
      await new Promise((resolve) => setTimeout(resolve, creditPollMs));
    }
    throw new Error(`top-up ${id} was not credited to ${account} in time`);
  };

  // One at a time, so concurrent uploads do not each buy the same shortfall.
  let funding: Promise<unknown> = Promise.resolve();
  const ensureCredit = (account: string, price: bigint, maxArio: number) => {
    const next = funding.then(() => creditFor(account, price, maxArio));
    funding = next.catch(() => undefined);
    return next;
  };

  return {
    async upload(data, tags) {
      const tagArray = tags
        ? Object.entries(tags).map(([name, value]) => ({ name, value }))
        : [];
      const dataItemOpts = tagArray.length > 0 ? { tags: tagArray } : undefined;

      // The ceiling is on the signed data item, not the payload (the review
      // on store#128 caught the envelope-wide hole at the boundary).
      const itemBytes = estimateDataItemBytes(data.length, signerKind, tags);
      if (maxArioPerUpload === undefined) {
        if (itemBytes <= TURBO_FREE_TIER_MAX_BYTES) {
          const result = await client.upload({
            data,
            ...(dataItemOpts ? { dataItemOpts } : {}),
          });
          return { txId: result.id };
        }
        throw new Error(
          `paid uploads are off: upload is ${data.length} bytes (~${itemBytes} signed), above the ` +
            `${TURBO_FREE_TIER_MAX_BYTES}-byte free tier, and no per-upload spend ceiling is ` +
            'configured (set STORE_TURBO_MAX_ARIO_PER_UPLOAD). Refused before contacting Turbo.'
        );
      }

      // The audit line: every act of spending says so, with its bound.
      log.info(
        `[store] paid upload: ${data.length} bytes (~${itemBytes} signed), ` +
          `paying from ${creditAccount} (ceiling ${maxArioPerUpload} $ARIO)`
      );
      const [cost] = await client.getUploadCosts({ bytes: [itemBytes] });
      if (!cost) throw new Error('Turbo returned no price for this upload');
      await ensureCredit(creditAccount as string, BigInt(cost.winc), maxArioPerUpload);
      const result = await client.upload({
        data,
        ...(dataItemOpts ? { dataItemOpts } : {}),
      });
      log.info(`[store] paid upload done: ${result.id}`);
      return { txId: result.id };
    },
  };
}
