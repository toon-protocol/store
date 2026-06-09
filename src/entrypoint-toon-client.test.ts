/**
 * Unit tests for entrypoint-toon-client.ts — direct-BTP mode (Phase 1).
 *
 * Covers the DIRECT_BTP / APEX_BTP_URL branch added to the toon-client pod
 * entrypoint:
 *   (a) parseEnv populates directBtp/apexBtpUrl and throws when DIRECT_BTP=1 but
 *       APEX_BTP_URL is missing (or malformed).
 *   (b) isValidDirectBtpUrl accepts ws://host[:port]/btp + wss://, rejects junk
 *       / .anon hostnames; the HS HOSTNAME_REGEX still rejects plain hosts/URLs.
 *   (c) resolveBtpWiring returns transport:{type:'direct'} + the plain apex URL
 *       in direct mode, and the legacy socks5 + ws://<host>:3000/btp otherwise.
 *
 * main() is gated on `!process.env.VITEST` so importing this module under vitest
 * does NOT boot Fastify / spawn anon — tests drive the exported helpers directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseEnv,
  isValidDirectBtpUrl,
  resolveBtpWiring,
} from './entrypoint-toon-client-helpers.js';

// Required base envs parseEnv() needs regardless of transport mode.
const BASE_ENV: Record<string, string> = {
  FAUCET_URL: 'http://faucet.local',
  EVM_RPC_URL: 'http://anvil.local:8545',
  SOLANA_RPC_URL: 'http://solana.local:8899',
};

// All env keys this suite mutates, restored between tests.
const ENV_KEYS = [
  ...Object.keys(BASE_ENV),
  'DIRECT_BTP',
  'APEX_BTP_URL',
  'ANYONE_PROXY_URLS',
  'ANON_SOCKS_PORT',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
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
});

// --- (a) parseEnv direct-BTP branch -----------------------------------------

describe('parseEnv — direct-BTP', () => {
  it('defaults directBtp=false and apexBtpUrl=undefined when DIRECT_BTP unset', () => {
    const env = parseEnv();
    expect(env.directBtp).toBe(false);
    expect(env.apexBtpUrl).toBeUndefined();
  });

  it('populates directBtp=true and apexBtpUrl when DIRECT_BTP=1 + APEX_BTP_URL set', () => {
    process.env['DIRECT_BTP'] = '1';
    process.env['APEX_BTP_URL'] = 'ws://apex.local:3000/btp';
    const env = parseEnv();
    expect(env.directBtp).toBe(true);
    expect(env.apexBtpUrl).toBe('ws://apex.local:3000/btp');
  });

  it('accepts other truthy DIRECT_BTP spellings (true/yes/on)', () => {
    for (const v of ['true', 'YES', 'on']) {
      process.env['DIRECT_BTP'] = v;
      process.env['APEX_BTP_URL'] = 'wss://apex.local/btp';
      expect(parseEnv().directBtp).toBe(true);
    }
  });

  it('treats DIRECT_BTP=0/false as disabled (no APEX_BTP_URL required)', () => {
    process.env['DIRECT_BTP'] = '0';
    expect(parseEnv().directBtp).toBe(false);
    process.env['DIRECT_BTP'] = 'false';
    expect(parseEnv().directBtp).toBe(false);
  });

  it('throws when DIRECT_BTP=1 but APEX_BTP_URL is missing', () => {
    process.env['DIRECT_BTP'] = '1';
    expect(() => parseEnv()).toThrow(/APEX_BTP_URL is unset/);
  });

  it('throws when DIRECT_BTP=1 but APEX_BTP_URL is malformed', () => {
    process.env['DIRECT_BTP'] = '1';
    process.env['APEX_BTP_URL'] = 'http://apex.local/btp'; // wrong scheme
    expect(() => parseEnv()).toThrow(/APEX_BTP_URL must be/);
  });

  it('does NOT require ANYONE_PROXY_URLS / ANON_SOCKS_PORT in direct mode', () => {
    process.env['DIRECT_BTP'] = '1';
    process.env['APEX_BTP_URL'] = 'ws://apex.local:3000/btp';
    // No proxy/anon envs set at all.
    const env = parseEnv();
    expect(env.directBtp).toBe(true);
    expect(env.anyoneProxyUrl).toBeNull();
  });
});

// --- (b) URL validators ------------------------------------------------------

describe('isValidDirectBtpUrl', () => {
  it('accepts ws://host:port/btp', () => {
    expect(isValidDirectBtpUrl('ws://apex.local:3000/btp')).toBe(true);
  });

  it('accepts ws://host/btp (no port) and wss://', () => {
    expect(isValidDirectBtpUrl('ws://apex.local/btp')).toBe(true);
    expect(isValidDirectBtpUrl('wss://apex.example.com:443/btp')).toBe(true);
  });

  it('accepts ipv4 host:port', () => {
    expect(isValidDirectBtpUrl('ws://127.0.0.1:3000/btp')).toBe(true);
  });

  it('rejects junk / non-string / wrong scheme / wrong path', () => {
    expect(isValidDirectBtpUrl('not-a-url')).toBe(false);
    expect(isValidDirectBtpUrl('http://apex.local/btp')).toBe(false);
    expect(isValidDirectBtpUrl('socks5h://apex.local/btp')).toBe(false);
    expect(isValidDirectBtpUrl('ws://apex.local/wrong')).toBe(false);
    expect(isValidDirectBtpUrl('ws://apex.local/btp?x=1')).toBe(false);
    expect(isValidDirectBtpUrl('ws://apex.local/btp#frag')).toBe(false);
    expect(isValidDirectBtpUrl('')).toBe(false);
    expect(isValidDirectBtpUrl(undefined)).toBe(false);
    expect(isValidDirectBtpUrl(123)).toBe(false);
  });

  it('rejects a bare .anon hostname (HS targets are not direct URLs)', () => {
    expect(isValidDirectBtpUrl('abcdef234567.anon')).toBe(false);
    expect(isValidDirectBtpUrl('abcdef234567.anyone')).toBe(false);
  });

  it('rejects an absurdly long URL', () => {
    expect(isValidDirectBtpUrl('ws://' + 'a'.repeat(600) + '/btp')).toBe(false);
  });
});

describe('HS HOSTNAME_REGEX (still strict)', () => {
  const HOSTNAME_REGEX = /^[a-z2-7]+\.(anyone|anon)$/;
  it('accepts .anon / .anyone but rejects plain hosts and direct URLs', () => {
    expect(HOSTNAME_REGEX.test('abcdef234567.anon')).toBe(true);
    expect(HOSTNAME_REGEX.test('abcdef234567.anyone')).toBe(true);
    // plain hosts / URLs must NOT match the HS regex
    expect(HOSTNAME_REGEX.test('apex.local')).toBe(false);
    expect(HOSTNAME_REGEX.test('localhost')).toBe(false);
    expect(HOSTNAME_REGEX.test('ws://apex.local:3000/btp')).toBe(false);
  });
});

// --- (c) transport wiring ----------------------------------------------------

describe('resolveBtpWiring', () => {
  it('direct mode → transport:{type:direct} + plain apex URL, keyed by URL', () => {
    const w = resolveBtpWiring({
      directBtp: true,
      apexBtpUrl: 'ws://apex.local:3000/btp',
      targetHostname: 'ignored.anon',
      resolvedProxy: null,
    });
    expect(w.transport).toEqual({ type: 'direct' });
    expect(w.btpUrl).toBe('ws://apex.local:3000/btp');
    expect(w.cacheKey).toBe('ws://apex.local:3000/btp');
  });

  it('HS mode → transport:{type:socks5} + ws://<host>:3000/btp, keyed by hostname', () => {
    const w = resolveBtpWiring({
      directBtp: false,
      targetHostname: 'abcdef234567.anon',
      resolvedProxy: 'socks5h://127.0.0.1:9050',
    });
    expect(w.transport).toEqual({
      type: 'socks5',
      socksProxy: 'socks5h://127.0.0.1:9050',
    });
    expect(w.btpUrl).toBe('ws://abcdef234567.anon:3000/btp');
    expect(w.cacheKey).toBe('abcdef234567.anon');
  });

  it('throws in direct mode when apexBtpUrl missing', () => {
    expect(() =>
      resolveBtpWiring({
        directBtp: true,
        targetHostname: 'x.anon',
        resolvedProxy: null,
      })
    ).toThrow(/requires apexBtpUrl/);
  });

  it('throws in HS mode when no proxy resolved', () => {
    expect(() =>
      resolveBtpWiring({
        directBtp: false,
        targetHostname: 'x.anon',
        resolvedProxy: null,
      })
    ).toThrow(/requires a resolved proxy/);
  });
});
