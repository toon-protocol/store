/**
 * Shared vocabulary for the kind:5095 ArNS job — the pieces both of its
 * operations need.
 *
 * kind:5095 has two ops (see ./arns-buy-handler and ./arns-ant-prepare), and
 * both read NIP-90 `param` tags, both validate an ArNS name, and both validate
 * base58 Solana pubkeys. Those definitions live here rather than in either
 * handler because `arns-buy-handler` imports the prepare op to dispatch to it —
 * so anything prepare needs FROM the buy handler would be an import cycle.
 * One definition of each rule, in the file neither op owns.
 */

/** The NIP-90 job kind for the ArNS job (both ops). */
export const ARNS_BUY_KIND = 5095;

/** A name registration kind: a time-boxed lease or a one-time permabuy. */
export type ArnsNameType = 'lease' | 'permabuy';

/** Which cluster's ar.io deployment to target (no testnet — ar.io has none). */
export type ArnsNetwork = 'mainnet' | 'devnet';

/** ArNS name rule: 1–51 chars, lowercase alnum + hyphens, no edge hyphens. */
export const ARNS_NAME_REGEX =
  /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,49}[a-z0-9])$/;

/** Base58 Solana pubkey (32–44 chars, Bitcoin/Solana alphabet). */
export const SOLANA_PUBKEY_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Arweave transaction id: 43 chars of URL-safe base64. Used for the ANT's
 * root `@` record target and its logo.
 */
export const ARWEAVE_TX_REGEX = /^[a-zA-Z0-9_-]{43}$/;

/** First value of a NIP-90 `['param', <key>, <value>]` tag, if present. */
export function paramTag(
  event: { tags: string[][] },
  key: string
): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === 'param' && tag[1] === key) return tag[2];
  }
  return undefined;
}
