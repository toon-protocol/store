import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseConfig, createConnectorAdminClient } from './entrypoint.js';

// Mock nostr-tools/pure to avoid native crypto dependency in tests
vi.mock('nostr-tools/pure', () => ({
  getPublicKey: vi.fn(() => 'a'.repeat(64)),
}));

describe('parseConfig', () => {
  const requiredEnv = {
    NODE_ID: 'test-node',
    NOSTR_SECRET_KEY: 'a'.repeat(64),
    ILP_ADDRESS: 'g.test',
  };

  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToClean = [
    'NODE_ID',
    'NOSTR_SECRET_KEY',
    'ILP_ADDRESS',
    'BTP_ENDPOINT',
    'BLS_PORT',
    'WS_PORT',
    'CONNECTOR_ADMIN_URL',
    'ARDRIVE_ENABLED',
    'ADDITIONAL_PEERS',
    'ASSET_CODE',
    'ASSET_SCALE',
    'BASE_PRICE_PER_BYTE',
  ];

  beforeEach(() => {
    for (const key of envKeysToClean) {
      savedEnv[key] = process.env[key];
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeysToClean) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      }
    }
  });

  it('returns correct defaults when only required env vars are set', () => {
    Object.assign(process.env, requiredEnv);

    const config = parseConfig();

    expect(config.nodeId).toBe('test-node');
    expect(config.ilpAddress).toBe('g.test');
    expect(config.btpEndpoint).toBe('ws://test-node:3000');
    expect(config.blsPort).toBe(3100);
    expect(config.wsPort).toBe(7100);
    expect(config.connectorAdminUrl).toBe('http://test-node:8081');
    expect(config.ardriveEnabled).toBe(true);
    expect(config.additionalPeersJson).toBeUndefined();
    expect(config.relayUrls).toEqual(['ws://localhost:7100']);
    expect(config.assetCode).toBe('USD');
    expect(config.assetScale).toBe(6);
    expect(config.basePricePerByte).toBe(10n);
  });

  it('parses ARDRIVE_ENABLED=false correctly', () => {
    Object.assign(process.env, requiredEnv, { ARDRIVE_ENABLED: 'false' });

    const config = parseConfig();

    expect(config.ardriveEnabled).toBe(false);
  });

  it('parses ARDRIVE_ENABLED=true correctly', () => {
    Object.assign(process.env, requiredEnv, { ARDRIVE_ENABLED: 'true' });

    const config = parseConfig();

    expect(config.ardriveEnabled).toBe(true);
  });

  it('defaults ARDRIVE_ENABLED to true when not set', () => {
    Object.assign(process.env, requiredEnv);

    const config = parseConfig();

    expect(config.ardriveEnabled).toBe(true);
  });

  it('parses ADDITIONAL_PEERS JSON correctly', () => {
    const peers = JSON.stringify([
      {
        pubkey: 'b'.repeat(64),
        relayUrl: 'wss://relay.example.com',
        ilpAddress: 'g.peer1',
        btpEndpoint: 'ws://peer1:3000',
      },
    ]);
    Object.assign(process.env, requiredEnv, { ADDITIONAL_PEERS: peers });

    const config = parseConfig();

    expect(config.additionalPeersJson).toBe(peers);
  });

  it('sets additionalPeersJson to undefined when ADDITIONAL_PEERS is not set', () => {
    Object.assign(process.env, requiredEnv);

    const config = parseConfig();

    expect(config.additionalPeersJson).toBeUndefined();
  });

  it('throws when NODE_ID is missing', () => {
    process.env['NOSTR_SECRET_KEY'] = 'a'.repeat(64);
    process.env['ILP_ADDRESS'] = 'g.test';

    expect(() => parseConfig()).toThrow('NODE_ID environment variable is required');
  });

  it('throws when NOSTR_SECRET_KEY is invalid', () => {
    process.env['NODE_ID'] = 'test-node';
    process.env['ILP_ADDRESS'] = 'g.test';
    process.env['NOSTR_SECRET_KEY'] = 'too-short';

    expect(() => parseConfig()).toThrow('NOSTR_SECRET_KEY must be a 64-character hex string');
  });

  it('throws when ILP_ADDRESS is missing', () => {
    process.env['NODE_ID'] = 'test-node';
    process.env['NOSTR_SECRET_KEY'] = 'a'.repeat(64);

    expect(() => parseConfig()).toThrow('ILP_ADDRESS environment variable is required');
  });

  it('builds relayUrls from wsPort', () => {
    Object.assign(process.env, requiredEnv, { WS_PORT: '9999' });

    const config = parseConfig();

    expect(config.relayUrls).toEqual(['ws://localhost:9999']);
  });
});

describe('createConnectorAdminClient', () => {
  const adminUrl = 'http://localhost:8081';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns object matching ConnectorAdminClient interface', () => {
    const client = createConnectorAdminClient(adminUrl);

    expect(client).toHaveProperty('addPeer');
    expect(client).toHaveProperty('removePeer');
    expect(typeof client.addPeer).toBe('function');
    expect(typeof client.removePeer).toBe('function');
  });

  it('addPeer() calls POST /peers with correct body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const client = createConnectorAdminClient(adminUrl);
    const peerConfig = {
      id: 'nostr-aabb11cc22dd33ee',
      url: 'ws://peer1:3000',
      authToken: 'token123',
      routes: [{ prefix: 'g.peer1', priority: 100 }],
    };

    await client.addPeer(peerConfig);

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8081/peers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(peerConfig),
    });
  });

  it('addPeer() throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createConnectorAdminClient(adminUrl);

    await expect(
      client.addPeer({ id: 'test', url: 'ws://x', authToken: 'tok' })
    ).rejects.toThrow('Failed to add peer: 500 Internal Server Error');
  });

  it('removePeer() calls DELETE /peers/:id', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const client = createConnectorAdminClient(adminUrl);
    await client.removePeer('nostr-aabb11cc22dd33ee');

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8081/peers/nostr-aabb11cc22dd33ee', {
      method: 'DELETE',
    });
  });

  it('removePeer() throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createConnectorAdminClient(adminUrl);

    await expect(client.removePeer('nonexistent')).rejects.toThrow(
      'Failed to remove peer: 404 Not Found'
    );
  });
});
