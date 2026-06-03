/**
 * Unit tests for entrypoint-mill.ts (Story 21.6.1)
 *
 * Covers:
 *   - AC-1 (Finding #10): MILL_CONFIG_JSON cleanup after parse
 *   - AC-3 (Finding #12): Structured JSON logging via logJson()
 *   - AC-4 (Finding #13): SIGQUIT registered alongside SIGTERM/SIGINT
 *
 * The IIFE at the bottom of entrypoint-mill.ts is gated on
 * `!process.env.VITEST`, so importing this module under vitest does NOT
 * trigger main() automatically — tests drive it explicitly with mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock for @toon-protocol/mill: startMill returns a stub instance
// so main() can complete without spinning up any real infrastructure.
// vi.hoisted moves the fn declarations above the vi.mock call so the factory
// can close over them safely (vi.mock is itself hoisted to the top of the file).
const { mockStartMill, mockStop } = vi.hoisted(() => {
  const stop = vi.fn(async () => undefined);
  const startMill = vi.fn(async () => ({
    identity: {
      pubkey: 'a'.repeat(64),
      evmAddress: '0x' + 'b'.repeat(40),
    },
    blsPort: 3200,
    stop,
  }));
  return { mockStartMill: startMill, mockStop: stop };
});

vi.mock('@toon-protocol/mill', () => ({
  startMill: mockStartMill,
}));

// Imports MUST come after the mock declaration (vi.mock is hoisted, but the
// import statement still resolves through the mocked module).
import {
  loadMillConfig,
  applyEnvOverlay,
  logJson,
  millEntrypointLogger,
  main,
} from './entrypoint-mill.js';

// --- Helpers ----------------------------------------------------------------

const SECRET_KEY_HEX = 'a'.repeat(64);

const VALID_CONFIG_OBJ = {
  secretKey: SECRET_KEY_HEX,
  swapPairs: [
    {
      from: { chain: 'evm:base:8453', asset: 'native' },
      to: { chain: 'evm:base:8453', asset: 'native' },
    },
  ],
  chains: [{ id: 'evm:base:8453' }],
  channels: {},
  inventory: {},
  relayUrls: [],
};

function validConfigJson(): string {
  return JSON.stringify(VALID_CONFIG_OBJ);
}

// Track env-var keys we mutate so we can restore them between tests.
const ENV_KEYS = [
  'MILL_CONFIG_JSON',
  'MILL_CONFIG_PATH',
  'NODE_NOSTR_SECRET_KEY',
];

// --- Lifecycle --------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[key];
  }
  mockStop.mockClear();
  mockStartMill.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  // Strip any signal listeners the tested code added; we do not touch
  // listeners that vitest itself may have registered (none for these signals).
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGQUIT');
  vi.restoreAllMocks();
});

// ===========================================================================
// AC-1 (Finding #10): MILL_CONFIG_JSON cleanup
// ===========================================================================

describe('AC-1: MILL_CONFIG_JSON cleanup (Finding #10)', () => {
  it('deletes process.env.MILL_CONFIG_JSON after a successful parse', () => {
    process.env['MILL_CONFIG_JSON'] = validConfigJson();

    loadMillConfig();

    expect(process.env['MILL_CONFIG_JSON']).toBeUndefined();
  });

  it('leaves process.env.MILL_CONFIG_JSON untouched when JSON.parse throws', () => {
    const malformed = '{ not valid json';
    process.env['MILL_CONFIG_JSON'] = malformed;

    expect(() => loadMillConfig()).toThrow(/Failed to parse MILL_CONFIG_JSON/);
    expect(process.env['MILL_CONFIG_JSON']).toBe(malformed);
  });

  it('deletes process.env.MILL_CONFIG_JSON when JSON.parse succeeds with null (falsy payload)', () => {
    // JSON.parse('null') succeeds but returns null — the delete must fire
    // before the null-guard so the env var is cleaned even for this edge case.
    process.env['MILL_CONFIG_JSON'] = 'null';

    expect(() => loadMillConfig()).toThrow(/Failed to parse MILL_CONFIG_JSON/);
    expect(process.env['MILL_CONFIG_JSON']).toBeUndefined();
  });

  it('does not delete MILL_CONFIG_PATH (path is not secret material)', () => {
    // Use a non-existent path so loadMillConfig throws — but the throw is on
    // readFileSync, AFTER the cleanup-decision point for MILL_CONFIG_JSON.
    // The relevant check is that we never call delete on MILL_CONFIG_PATH.
    const pathValue = '/tmp/does-not-exist-21-6-1.json';
    process.env['MILL_CONFIG_PATH'] = pathValue;

    expect(() => loadMillConfig()).toThrow(/Failed to read MILL_CONFIG_PATH/);
    expect(process.env['MILL_CONFIG_PATH']).toBe(pathValue);
  });
});

// ===========================================================================
// AC-3 (Finding #12): Structured JSON logging
// ===========================================================================

describe('AC-3: Structured JSON logging (Finding #12)', () => {
  it('logJson(info, ...) writes one JSON object per line to stdout', () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    logJson('info', 'unit_test', { foo: 'bar', count: 7 });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const written = String(stdoutSpy.mock.calls[0]?.[0] ?? '');
    expect(written.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['scope']).toBe('mill-entrypoint');
    expect(parsed['msg']).toBe('unit_test');
    expect(parsed['foo']).toBe('bar');
    expect(parsed['count']).toBe(7);
    expect(typeof parsed['ts']).toBe('number');
  });

  it('logJson(error, ...) writes to stderr, not stdout', () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    logJson('error', 'something_broke', { err: 'boom' });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(
      String(stderrSpy.mock.calls[0]?.[0] ?? '').trimEnd()
    ) as Record<string, unknown>;
    expect(parsed['level']).toBe('error');
    expect(parsed['msg']).toBe('something_broke');
    expect(parsed['err']).toBe('boom');
  });

  it('main() emits structured starting + mill_ready lines (no ASCII banner)', async () => {
    process.env['MILL_CONFIG_JSON'] = validConfigJson();

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    await main();

    // Every captured line must be valid JSON terminated by a newline.
    const parsedLines = stdoutWrites.map((line) => {
      expect(line.endsWith('\n')).toBe(true);
      return JSON.parse(line.trimEnd()) as Record<string, unknown>;
    });

    const messages = parsedLines.map((p) => p['msg']);
    expect(messages).toContain('starting');
    expect(messages).toContain('mill_ready');

    const ready = parsedLines.find((p) => p['msg'] === 'mill_ready');
    expect(ready).toBeDefined();
    expect(ready?.['pubkey']).toBe('a'.repeat(64));
    // Issues #80/#88: the swap gift-wrap recipient is the same MILL_MNEMONIC
    // identity pubkey, surfaced under an unambiguous field for client discovery.
    expect(ready?.['swapRecipientPubkey']).toBe('a'.repeat(64));
    expect(ready?.['evmAddress']).toBe('0x' + 'b'.repeat(40));
    expect(ready?.['blsPort']).toBe(3200);
    expect(ready?.['swapPairCount']).toBe(1);

    // No remnants of the old ASCII banner should appear in the captured stream.
    for (const line of stdoutWrites) {
      expect(line).not.toMatch(/Mill Ready/);
      expect(line).not.toMatch(/╔/);
    }
  });
});

// ===========================================================================
// Issue #87: millEntrypointLogger serializes structured payloads (no
// "[object Object]"). The SDK swap-handler + claim issuer log pino-style with
// a single object-first merging argument; the shim must preserve the event
// name and error fields instead of collapsing them.
// ===========================================================================

describe('Issue #87: millEntrypointLogger object-first serialization', () => {
  function captureLine(
    fn: (logger: ReturnType<typeof millEntrypointLogger>) => void,
    stream: 'stdout' | 'stderr' = 'stdout'
  ): Record<string, unknown> {
    const spy = vi
      .spyOn(process[stream], 'write')
      .mockImplementation(() => true);
    fn(millEntrypointLogger());
    expect(spy).toHaveBeenCalledTimes(1);
    const written = String(spy.mock.calls[0]?.[0] ?? '');
    return JSON.parse(written.trimEnd()) as Record<string, unknown>;
  }

  it('object-first (pino merging object) lifts event name and keeps fields — not "[object Object]"', () => {
    const parsed = captureLine(
      (logger) =>
        logger.error?.({
          event: 'swap_handler.issuer_failed',
          err: 'no inventory for evm:base',
          pair: 'USDC:solana',
        }),
      'stderr'
    );
    expect(parsed['msg']).not.toBe('[object Object]');
    expect(parsed['msg']).toBe('swap_handler.issuer_failed');
    expect(parsed['err']).toBe('no inventory for evm:base');
    expect(parsed['pair']).toBe('USDC:solana');
    // `event` is lifted to msg, not duplicated as a field.
    expect(parsed['event']).toBeUndefined();
  });

  it('object-first with `msg` key (no `event`) uses msg as the message', () => {
    const parsed = captureLine((logger) =>
      logger.info?.({ msg: 'swap_handler.claim_issued', amount: 1000 })
    );
    expect(parsed['msg']).toBe('swap_handler.claim_issued');
    expect(parsed['amount']).toBe(1000);
  });

  it('object-first followed by a format string folds the string into the message', () => {
    const parsed = captureLine(
      (logger) =>
        logger.warn?.({ event: 'swap_handler.rate_conversion_failed' }, 'NaN'),
      'stderr'
    );
    expect(parsed['msg']).toBe('swap_handler.rate_conversion_failed: NaN');
  });

  it('string-first (mill.ts convention) still works', () => {
    // warn routes to stderr (see logJson).
    const parsed = captureLine(
      (logger) =>
        logger.warn?.('mill.peerInfo.publish_failed', { err: 'relay down' }),
      'stderr'
    );
    expect(parsed['msg']).toBe('mill.peerInfo.publish_failed');
    expect(parsed['err']).toBe('relay down');
  });
});

// ===========================================================================
// AC-4 (Finding #13): SIGQUIT handling
// ===========================================================================

describe('AC-4: SIGQUIT handling (Finding #13)', () => {
  // Each test runs main() to register fresh handlers, then emits one signal.
  // shutdown() calls process.exit, so we stub it to a no-op; we also stub
  // the structured-log writers to keep test output clean.
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.env['MILL_CONFIG_JSON'] = validConfigJson();
  });

  async function emitAndAwaitShutdown(
    signal: 'SIGTERM' | 'SIGINT' | 'SIGQUIT'
  ): Promise<void> {
    await main();
    // process.emit returns synchronously; the listener is async (it awaits
    // instance.stop), so we yield once to let the microtask queue drain.
    process.emit(signal);
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('registers SIGTERM handler that calls instance.stop() exactly once', async () => {
    await emitAndAwaitShutdown('SIGTERM');
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('registers SIGINT handler that calls instance.stop() exactly once', async () => {
    await emitAndAwaitShutdown('SIGINT');
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('registers SIGQUIT handler that calls instance.stop() exactly once', async () => {
    await emitAndAwaitShutdown('SIGQUIT');
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('main() registers a listener for each of SIGTERM, SIGINT, SIGQUIT', async () => {
    const beforeTerm = process.listenerCount('SIGTERM');
    const beforeInt = process.listenerCount('SIGINT');
    const beforeQuit = process.listenerCount('SIGQUIT');

    await main();

    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);
    expect(process.listenerCount('SIGQUIT')).toBe(beforeQuit + 1);
  });
});

// ===========================================================================
// Sanity: applyEnvOverlay still wires the embedded connector port
// ===========================================================================

describe('applyEnvOverlay (regression sanity)', () => {
  it('forces btpServerPort = 3000 (embedded connector)', () => {
    const out = applyEnvOverlay({
      swapPairs: [],
      chains: [],
      channels: {},
      inventory: {},
      relayUrls: [],
    } as never);
    expect((out as { btpServerPort?: number }).btpServerPort).toBe(3000);
  });
});
