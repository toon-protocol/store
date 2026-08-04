/**
 * Unit tests for the kind:5098 evm-gas-station handler (issue #68,
 * toon-meta#261).
 *
 * HARD SAFETY: no test touches a live chain — the handler runs against stub
 * RPC/signer seams ({@link EvmGasStationChainDeps}). The adversarial drills
 * here are the offline twins of the kind:5096 Solana drills (wrong target →
 * target_not_whitelisted, wrong selector → selector_not_whitelisted, over
 * cap → gas/value_cap_exceeded, expiry → quote_expired, post-simulation
 * over-cap → alarm).
 */

import { describe, it, expect, vi } from 'vitest';
import { id as keccakId } from 'ethers';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  createEvmGasStationHandler,
  DEFAULT_EVM_POLICY,
  EVM_GAS_STATION_KIND,
  inspectForwardRequest,
  parseForwardRequest,
  TOKEN_NETWORK_FUNCTION_WHITELIST,
  TOKEN_NETWORK_SELECTOR_WHITELIST,
  type EvmChainConfig,
  type EvmGasStationChainDeps,
  type EvmGasStationExecuteReceipt,
  type EvmGasStationFailureReceipt,
  type EvmGasStationPolicy,
  type EvmGasStationQuoteReceipt,
  type ForwardRequestData,
} from './evm-gas-station-handler.js';
import type { StoreHandlerContext } from './store-backend.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const CHAIN_ID = 84532; // Base Sepolia, per README's TOON payment-channel contracts table
const FORWARDER = '0x111111111111111111111111111111111111111f';
const TOKEN_NETWORK = '0x222222222222222222222222222222222222222f';
const RELAYER = '0x333333333333333333333333333333333333333f';
const CLIENT = '0x444444444444444444444444444444444444444f';
const OTHER_CONTRACT = '0x555555555555555555555555555555555555555f';

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function selector(sig: string): string {
  return keccakId(sig).slice(0, 10).toLowerCase();
}

const OPEN_CHANNEL_SELECTOR = selector('openChannel(address,uint256)');

function chain(overrides: Partial<EvmChainConfig> = {}): EvmChainConfig {
  return {
    chainId: CHAIN_ID,
    rpcUrl: 'http://127.0.0.1:8545',
    forwarderAddress: FORWARDER,
    tokenNetworkAddress: TOKEN_NETWORK,
    relayerPrivateKey: '0x' + '7'.repeat(64),
    ...overrides,
  };
}

function policyWith(overrides: Partial<EvmGasStationPolicy> = {}): EvmGasStationPolicy {
  return { ...DEFAULT_EVM_POLICY, ...overrides };
}

function forwardRequest(overrides: Partial<ForwardRequestData> = {}): ForwardRequestData {
  return {
    from: CLIENT,
    to: TOKEN_NETWORK,
    value: '0',
    gas: '150000',
    deadline: NOW_SEC + 300,
    data: selector(TOKEN_NETWORK_FUNCTION_WHITELIST.SETTLE_CHANNEL) + 'ab'.repeat(32),
    signature: '0x' + '11'.repeat(65),
    ...overrides,
  };
}

// ── inspectForwardRequest (mitigations b + d) ────────────────────────────────

describe('inspectForwardRequest', () => {
  it('accepts a settle request against the configured TokenNetwork', () => {
    const res = inspectForwardRequest(forwardRequest(), chain(), policyWith(), () => NOW_MS);
    expect(res.ok).toBe(true);
  });

  it('accepts deposit and close selectors too', () => {
    for (const sig of [
      TOKEN_NETWORK_FUNCTION_WHITELIST.DEPOSIT,
      TOKEN_NETWORK_FUNCTION_WHITELIST.CLOSE_CHANNEL,
    ]) {
      const res = inspectForwardRequest(
        forwardRequest({ data: selector(sig) + 'ab'.repeat(32) }),
        chain(),
        policyWith(),
        () => NOW_MS
      );
      expect(res.ok).toBe(true);
    }
  });

  it('DRILL: a request targeting a different contract is target_not_whitelisted', () => {
    const res = inspectForwardRequest(
      forwardRequest({ to: OTHER_CONTRACT }),
      chain(),
      policyWith(),
      () => NOW_MS
    );
    expect(res).toMatchObject({ ok: false, reason: 'target_not_whitelisted' });
  });

  it('DRILL: openChannel (not deposit/close/settle) is selector_not_whitelisted', () => {
    const res = inspectForwardRequest(
      forwardRequest({ data: OPEN_CHANNEL_SELECTOR + 'ab'.repeat(32) }),
      chain(),
      policyWith(),
      () => NOW_MS
    );
    expect(res).toMatchObject({ ok: false, reason: 'selector_not_whitelisted' });
  });

  it('DRILL: nonzero value on a non-payable channel op is value_cap_exceeded', () => {
    const res = inspectForwardRequest(
      forwardRequest({ value: '1' }),
      chain(),
      policyWith(),
      () => NOW_MS
    );
    expect(res).toMatchObject({ ok: false, reason: 'value_cap_exceeded' });
  });

  it('DRILL: gas over the policy cap is gas_cap_exceeded', () => {
    const res = inspectForwardRequest(
      forwardRequest({ gas: (DEFAULT_EVM_POLICY.maxGas + 1n).toString() }),
      chain(),
      policyWith(),
      () => NOW_MS
    );
    expect(res).toMatchObject({ ok: false, reason: 'gas_cap_exceeded' });
  });

  it('DRILL: an already-expired deadline is deadline_invalid', () => {
    const res = inspectForwardRequest(
      forwardRequest({ deadline: NOW_SEC - 1 }),
      chain(),
      policyWith(),
      () => NOW_MS
    );
    expect(res).toMatchObject({ ok: false, reason: 'deadline_invalid' });
  });

  it('DRILL: a deadline beyond the policy horizon is deadline_invalid', () => {
    const res = inspectForwardRequest(
      forwardRequest({ deadline: NOW_SEC + DEFAULT_EVM_POLICY.maxDeadlineSeconds + 1 }),
      chain(),
      policyWith(),
      () => NOW_MS
    );
    expect(res).toMatchObject({ ok: false, reason: 'deadline_invalid' });
  });
});

// ── parseForwardRequest ───────────────────────────────────────────────────────

describe('parseForwardRequest', () => {
  it('accepts a well-formed request and checksums the addresses', () => {
    const parsed = parseForwardRequest(forwardRequest());
    expect(parsed).not.toBeNull();
    expect(parsed?.data).toBe(forwardRequest().data);
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['missing signature', { ...forwardRequest(), signature: undefined }],
    ['bad from address', { ...forwardRequest(), from: '0xnope' }],
    ['bad to address', { ...forwardRequest(), to: '0xnope' }],
    ['non-hex data', { ...forwardRequest(), data: 'not-hex' }],
    ['non-numeric value', { ...forwardRequest(), value: 'lots' }],
    ['negative gas', { ...forwardRequest(), gas: '-1' }],
    ['deadline as string', { ...forwardRequest(), deadline: '123' }],
  ])('rejects %s', (_label, raw) => {
    expect(parseForwardRequest(raw)).toBeNull();
  });
});

// ── createEvmGasStationHandler (quote → execute, mitigation c, idempotency) ──

function jobEvent(params: Record<string, string>, kind = EVM_GAS_STATION_KIND): NostrEvent {
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

function quoteParams(overrides: Record<string, string> = {}) {
  return { phase: 'quote', chainId: String(CHAIN_ID), from: CLIENT, ...overrides };
}

function requestParam(request: ForwardRequestData): string {
  return Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
}

interface StubOptions {
  /** A single balance for every call, or a sequence consumed call-by-call (last value repeats after exhausted). */
  balance?: bigint | bigint[];
  gasPrice?: bigint;
  nonce?: bigint;
  verify?: boolean;
  estimateGas?: bigint | (() => bigint);
  estimateGasError?: string;
  txHash?: string;
  receiptStatus?: 1 | 0 | null; // null → confirmation_timeout
  gasUsed?: bigint;
  effectiveGasPriceWei?: bigint | null;
  sendError?: string;
}

function makeStubDeps(opts: StubOptions = {}) {
  const balanceSeq = Array.isArray(opts.balance)
    ? [...opts.balance]
    : [opts.balance ?? 10n ** 18n]; // 1 ETH float, generous
  const gasPrice = opts.gasPrice ?? 1_000_000_000n; // 1 gwei
  const sent: { request: ForwardRequestData; gasLimit: bigint }[] = [];

  const deps: EvmGasStationChainDeps = {
    relayerAddress: RELAYER,
    getForwarderNonce: vi.fn(async () => opts.nonce ?? 0n),
    getRelayerBalance: vi.fn(async () =>
      balanceSeq.length > 1 ? balanceSeq.shift()! : balanceSeq[0]!
    ),
    getGasPrice: vi.fn(async () => gasPrice),
    verifyRequest: vi.fn(async () => opts.verify ?? true),
    estimateExecuteGas: vi.fn(async () => {
      if (opts.estimateGasError) throw new Error(opts.estimateGasError);
      return typeof opts.estimateGas === 'function' ? opts.estimateGas() : (opts.estimateGas ?? 150_000n);
    }),
    sendExecuteTransaction: vi.fn(async (request, gasLimit) => {
      if (opts.sendError) throw new Error(opts.sendError);
      sent.push({ request, gasLimit });
      return opts.txHash ?? '0x' + 'ab'.repeat(32);
    }),
    waitForReceipt: vi.fn(async () => {
      if (opts.receiptStatus === null) return null;
      return {
        status: opts.receiptStatus ?? 1,
        blockNumber: 42,
        gasUsed: opts.gasUsed ?? 150_000n,
        effectiveGasPriceWei: opts.effectiveGasPriceWei === undefined ? gasPrice : opts.effectiveGasPriceWei,
      };
    }),
  };
  return { deps, sent };
}

function makeHandler(opts: StubOptions & { now?: () => number; chains?: EvmChainConfig[] } = {}) {
  const stub = makeStubDeps(opts);
  const handler = createEvmGasStationHandler({
    chains: opts.chains ?? [chain()],
    loadDeps: async () => stub.deps,
    now: opts.now ?? (() => NOW_MS),
    confirm: { timeoutMs: 200, intervalMs: 10 },
  });
  return { handler, ...stub };
}

async function quoteThenExecuteParams(
  handler: (ctx: StoreHandlerContext) => Promise<unknown>,
  requestOverrides: Partial<ForwardRequestData> = {},
  idempotencyKey = 'idem-1'
) {
  const quoteRes = await handler(ctxFor(jobEvent(quoteParams())));
  const quote = decodeReceipt<EvmGasStationQuoteReceipt>(quoteRes);
  expect(quote.status).toBe('ok');
  const request = forwardRequest(requestOverrides);
  return {
    quote,
    request,
    executeParams: {
      phase: 'execute',
      chainId: String(CHAIN_ID),
      request: requestParam(request),
      quoteId: quote.quoteId,
      idempotencyKey,
    },
  };
}

describe('createEvmGasStationHandler', () => {
  it('quote returns relayer/forwarder/tokenNetwork/nonce/caps; execute simulates, broadcasts, confirms', async () => {
    const { handler, deps, sent } = makeHandler({ nonce: 7n });
    const { quote, executeParams } = await quoteThenExecuteParams(handler);
    expect(quote).toMatchObject({
      chainId: CHAIN_ID,
      relayer: RELAYER,
      forwarder: FORWARDER,
      tokenNetwork: TOKEN_NETWORK,
      forwarderNonce: '7',
      maxGas: DEFAULT_EVM_POLICY.maxGas.toString(),
      maxValueWei: '0',
    });
    expect(quote.expiresAt).toBeGreaterThan(NOW_MS - 1);

    const res = await handler(ctxFor(jobEvent(executeParams)));
    const receipt = decodeReceipt<EvmGasStationExecuteReceipt>(res);
    expect(receipt).toMatchObject({
      status: 'ok',
      chainId: CHAIN_ID,
      txHash: '0x' + 'ab'.repeat(32),
      blockNumber: 42,
      gasUsed: '150000',
    });
    expect(sent).toHaveLength(1);
    expect(deps.verifyRequest).toHaveBeenCalledTimes(1);
    expect(deps.estimateExecuteGas).toHaveBeenCalledTimes(1);
  });

  it('replays an idempotencyKey without re-broadcasting', async () => {
    const { handler, sent } = makeHandler();
    const { executeParams } = await quoteThenExecuteParams(handler, {}, 'idem-replay');
    decodeReceipt<EvmGasStationExecuteReceipt>(await handler(ctxFor(jobEvent(executeParams))));
    const second = decodeReceipt<EvmGasStationExecuteReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(second.replayed).toBe(true);
    expect(second.txHash).toBe('0x' + 'ab'.repeat(32));
    expect(sent).toHaveLength(1);
  });

  it('DRILL: submit after expiresAt → quote_expired, nothing simulated or sent', async () => {
    let t = NOW_MS;
    const { handler, deps, sent } = makeHandler({ now: () => t });
    const { executeParams } = await quoteThenExecuteParams(handler);
    t += 121_000; // past the 120s quote TTL
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'quote_expired' });
    expect(sent).toHaveLength(0);
    expect(deps.verifyRequest).not.toHaveBeenCalled();
    // Re-quote succeeds cleanly.
    const again = decodeReceipt<EvmGasStationQuoteReceipt>(
      await handler(ctxFor(jobEvent(quoteParams())))
    );
    expect(again.status).toBe('ok');
  });

  it('DRILL: a request targeting a foreign contract is target_not_whitelisted, nothing simulated or sent', async () => {
    const { handler, deps, sent } = makeHandler();
    const { executeParams } = await quoteThenExecuteParams(handler, { to: OTHER_CONTRACT });
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'target_not_whitelisted' });
    expect(sent).toHaveLength(0);
    expect(deps.verifyRequest).not.toHaveBeenCalled();
  });

  it('DRILL: openChannel selector is selector_not_whitelisted, nothing simulated or sent', async () => {
    const { handler, deps, sent } = makeHandler();
    const { executeParams } = await quoteThenExecuteParams(handler, {
      data: OPEN_CHANNEL_SELECTOR + 'ab'.repeat(32),
    });
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'selector_not_whitelisted' });
    expect(sent).toHaveLength(0);
    expect(deps.verifyRequest).not.toHaveBeenCalled();
  });

  it('DRILL: requested gas above the cap is gas_cap_exceeded before any RPC call', async () => {
    const { handler, deps, sent } = makeHandler();
    const { executeParams } = await quoteThenExecuteParams(handler, {
      gas: (DEFAULT_EVM_POLICY.maxGas + 1n).toString(),
    });
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'gas_cap_exceeded' });
    expect(sent).toHaveLength(0);
    expect(deps.verifyRequest).not.toHaveBeenCalled();
  });

  it('DRILL: forwarder.verify() rejecting the request is signature_invalid, nothing simulated or sent', async () => {
    const { handler, deps, sent } = makeHandler({ verify: false });
    const { executeParams } = await quoteThenExecuteParams(handler);
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'signature_invalid' });
    expect(sent).toHaveLength(0);
    expect(deps.estimateExecuteGas).not.toHaveBeenCalled();
  });

  it('a reverting simulation is simulation_failed, nothing sent', async () => {
    const { handler, sent } = makeHandler({ estimateGasError: 'execution reverted: InvalidChannelState()' });
    const { executeParams } = await quoteThenExecuteParams(handler);
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'simulation_failed' });
    expect(res.detail).toContain('InvalidChannelState');
    expect(sent).toHaveLength(0);
  });

  it('DRILL: post-simulation over-cap gas estimate → gas_cap_exceeded + alarm, nothing sent', async () => {
    // Static inspection alone can't catch a target-side gas blowup — the
    // simulated estimate (mitigation c) must still be the backstop, even for
    // a request whose declared `gas` field was under the cap.
    const { handler, sent } = makeHandler({
      estimateGas: () => DEFAULT_EVM_POLICY.maxGas + 1n,
    });
    const alarm = vi.spyOn(console, 'error').mockImplementation((message) => {
      expect(message).toEqual(expect.stringContaining('ALARM'));
    });
    try {
      const { executeParams } = await quoteThenExecuteParams(handler);
      const res = decodeReceipt<EvmGasStationFailureReceipt>(
        await handler(ctxFor(jobEvent(executeParams)))
      );
      expect(res).toMatchObject({ status: 'failed', reason: 'gas_cap_exceeded' });
      expect(sent).toHaveLength(0);
      expect(alarm).toHaveBeenCalledWith(expect.stringContaining('ALARM'));
    } finally {
      alarm.mockRestore();
    }
  });

  it('unknown quote id → unknown_quote', async () => {
    const { handler } = makeHandler();
    const { executeParams } = await quoteThenExecuteParams(handler);
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent({ ...executeParams, quoteId: 'nope' })))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'unknown_quote' });
  });

  it('execute against a different chainId than the quote is request_mismatch', async () => {
    const { handler } = makeHandler({
      chains: [chain(), chain({ chainId: 1, forwarderAddress: OTHER_CONTRACT })],
    });
    const { executeParams } = await quoteThenExecuteParams(handler);
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent({ ...executeParams, chainId: '1' })))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'request_mismatch' });
  });

  it('execute request.from mismatching the quoted signer is request_mismatch', async () => {
    const { handler } = makeHandler();
    const { executeParams } = await quoteThenExecuteParams(handler, {
      from: OTHER_CONTRACT,
    });
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'request_mismatch' });
  });

  it('quote refuses when the relayer float cannot cover the job (float_exhausted)', async () => {
    const { handler } = makeHandler({ balance: 1n });
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(quoteParams())))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'float_exhausted' });
  });

  it('execute refuses when the float drops below the estimated cost between quote and execute', async () => {
    // gasPrice=1e9, maxGas=300_000 → quote's 2x check needs balance >= 6e14.
    // First balance call (quote) clears that; the second (execute, post-sim)
    // sees a balance the drained float would leave behind.
    const { handler, sent } = makeHandler({
      balance: [10n ** 18n, 1n],
      gasPrice: 1_000_000_000n,
    });
    const { executeParams } = await quoteThenExecuteParams(handler);
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'float_exhausted' });
    expect(sent).toHaveLength(0);
  });

  it('confirmation timeout when the receipt never lands', async () => {
    const { handler, sent } = makeHandler({ receiptStatus: null });
    const { executeParams } = await quoteThenExecuteParams(handler);
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'confirmation_timeout' });
    expect(sent).toHaveLength(1); // it WAS broadcast — just never confirmed in time
  });

  it('an on-chain-failed transaction is broadcast_failed', async () => {
    const { handler } = makeHandler({ receiptStatus: 0 });
    const { executeParams } = await quoteThenExecuteParams(handler);
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'broadcast_failed' });
  });

  it('a broadcast error is broadcast_failed', async () => {
    const { handler } = makeHandler({ sendError: 'nonce too low' });
    const { executeParams } = await quoteThenExecuteParams(handler);
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(executeParams)))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'broadcast_failed' });
    expect(res.detail).toContain('nonce too low');
  });

  it('quote for an unconfigured chain is chain_not_supported', async () => {
    const { handler } = makeHandler();
    const res = decodeReceipt<EvmGasStationFailureReceipt>(
      await handler(ctxFor(jobEvent(quoteParams({ chainId: '999999' }))))
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'chain_not_supported' });
  });

  it('wrong kind / missing phase are transport rejects (F00)', async () => {
    const { handler } = makeHandler();
    expect(
      await handler(ctxFor(jobEvent(quoteParams(), 5094)))
    ).toMatchObject({ accept: false, code: 'F00' });
    expect(await handler(ctxFor(jobEvent({})))).toMatchObject({
      accept: false,
      code: 'F00',
    });
  });
});

describe('TOKEN_NETWORK_SELECTOR_WHITELIST', () => {
  it('contains exactly deposit/close/settle, excluding open/claim', () => {
    expect(TOKEN_NETWORK_SELECTOR_WHITELIST.size).toBe(3);
    expect(TOKEN_NETWORK_SELECTOR_WHITELIST.has(selector(TOKEN_NETWORK_FUNCTION_WHITELIST.DEPOSIT))).toBe(true);
    expect(TOKEN_NETWORK_SELECTOR_WHITELIST.has(selector(TOKEN_NETWORK_FUNCTION_WHITELIST.CLOSE_CHANNEL))).toBe(true);
    expect(TOKEN_NETWORK_SELECTOR_WHITELIST.has(selector(TOKEN_NETWORK_FUNCTION_WHITELIST.SETTLE_CHANNEL))).toBe(true);
    expect(TOKEN_NETWORK_SELECTOR_WHITELIST.has(OPEN_CHANNEL_SELECTOR)).toBe(false);
  });
});
