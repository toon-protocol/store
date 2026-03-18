import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock nostr-tools/pure to avoid native crypto dependency in tests
vi.mock('nostr-tools/pure', () => ({
  getPublicKey: vi.fn(() => 'a'.repeat(64)),
}));

import {
  parseConfig,
  createConnectorAdminClient,
  createChannelClient,
  waitForConnector,
} from './shared.js';

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
    'CONNECTOR_URL',
    'SUPPORTED_CHAINS',
    'SETTLEMENT_ADDRESS_EVM_BASE_8453',
    'PREFERRED_TOKEN_EVM_BASE_8453',
    'TOKEN_NETWORK_EVM_BASE_8453',
    'TOKEN_NETWORK_XRP_MAINNET',
    'SETTLEMENT_ADDRESS_XRP_MAINNET',
    'SETTLEMENT_TIMEOUT',
    'INITIAL_DEPOSIT',
    'TOON_CHAIN',
    'TOON_RPC_URL',
    'TOON_TOKEN_NETWORK',
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

    expect(() => parseConfig()).toThrow(
      'NODE_ID environment variable is required'
    );
  });

  it('throws when NOSTR_SECRET_KEY is invalid', () => {
    process.env['NODE_ID'] = 'test-node';
    process.env['ILP_ADDRESS'] = 'g.test';
    process.env['NOSTR_SECRET_KEY'] = 'too-short';

    expect(() => parseConfig()).toThrow(
      'NOSTR_SECRET_KEY must be a 64-character hex string'
    );
  });

  it('throws when ILP_ADDRESS is missing', () => {
    process.env['NODE_ID'] = 'test-node';
    process.env['NOSTR_SECRET_KEY'] = 'a'.repeat(64);

    expect(() => parseConfig()).toThrow(
      'ILP_ADDRESS environment variable is required'
    );
  });

  it('builds relayUrls from wsPort', () => {
    Object.assign(process.env, requiredEnv, { WS_PORT: '9999' });

    const config = parseConfig();

    expect(config.relayUrls).toEqual(['ws://localhost:9999']);
  });

  it('throws when CONNECTOR_URL is not a valid URL', () => {
    Object.assign(process.env, requiredEnv, { CONNECTOR_URL: 'not-a-url' });

    expect(() => parseConfig()).toThrow(
      'CONNECTOR_URL is not a valid URL: not-a-url'
    );
  });

  it('accepts valid CONNECTOR_URL and stores in config', () => {
    Object.assign(process.env, requiredEnv, {
      CONNECTOR_URL: 'http://localhost:3000',
    });

    const config = parseConfig();

    expect(config.connectorUrl).toBe('http://localhost:3000');
  });

  it('parses SUPPORTED_CHAINS with settlement address into settlementInfo', () => {
    Object.assign(process.env, requiredEnv, {
      SUPPORTED_CHAINS: 'evm:base:8453',
      SETTLEMENT_ADDRESS_EVM_BASE_8453: '0x1234567890abcdef',
    });

    const config = parseConfig();

    expect(config.settlementInfo).toBeDefined();
    expect(config.settlementInfo?.supportedChains).toEqual(['evm:base:8453']);
    expect(config.settlementInfo?.settlementAddresses).toEqual({
      'evm:base:8453': '0x1234567890abcdef',
    });
  });

  it('logs warning when SUPPORTED_CHAINS has chain without settlement address', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(process.env, requiredEnv, {
      SUPPORTED_CHAINS: 'evm:base:8453',
    });

    parseConfig();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'chain "evm:base:8453" listed in SUPPORTED_CHAINS but no SETTLEMENT_ADDRESS_*'
      )
    );
    warnSpy.mockRestore();
  });

  it('parses INITIAL_DEPOSIT from env var', () => {
    Object.assign(process.env, requiredEnv, { INITIAL_DEPOSIT: '1000000' });

    const config = parseConfig();

    expect(config.initialDeposit).toBe('1000000');
  });

  it('defaults initialDeposit to undefined when INITIAL_DEPOSIT not set', () => {
    Object.assign(process.env, requiredEnv);

    const config = parseConfig();

    expect(config.initialDeposit).toBeUndefined();
  });

  it('throws when INITIAL_DEPOSIT is not a non-negative integer string', () => {
    Object.assign(process.env, requiredEnv, { INITIAL_DEPOSIT: 'abc' });

    expect(() => parseConfig()).toThrow(
      'INITIAL_DEPOSIT must be a non-negative integer string: abc'
    );
  });

  it('parses SETTLEMENT_TIMEOUT from env var', () => {
    Object.assign(process.env, requiredEnv, { SETTLEMENT_TIMEOUT: '3600' });

    const config = parseConfig();

    expect(config.settlementTimeout).toBe(3600);
  });

  it('defaults settlementTimeout to undefined when SETTLEMENT_TIMEOUT not set', () => {
    Object.assign(process.env, requiredEnv);

    const config = parseConfig();

    expect(config.settlementTimeout).toBeUndefined();
  });

  it('throws when SETTLEMENT_TIMEOUT is not a valid number', () => {
    Object.assign(process.env, requiredEnv, {
      SETTLEMENT_TIMEOUT: 'not-a-number',
    });

    expect(() => parseConfig()).toThrow(
      'SETTLEMENT_TIMEOUT must be a positive integer: not-a-number'
    );
  });

  it('parses single TOKEN_NETWORK_* env var into settlementInfo.tokenNetworks', () => {
    Object.assign(process.env, requiredEnv, {
      SUPPORTED_CHAINS: 'evm:base:8453',
      SETTLEMENT_ADDRESS_EVM_BASE_8453: '0xADDR',
      TOKEN_NETWORK_EVM_BASE_8453: '0xTOKEN_NET',
    });

    const config = parseConfig();

    expect(config.settlementInfo?.tokenNetworks).toEqual({
      'evm:base:8453': '0xTOKEN_NET',
    });
  });

  it('parses multiple TOKEN_NETWORK_* env vars across chains', () => {
    Object.assign(process.env, requiredEnv, {
      SUPPORTED_CHAINS: 'evm:base:8453,xrp:mainnet',
      SETTLEMENT_ADDRESS_EVM_BASE_8453: '0xADDR1',
      SETTLEMENT_ADDRESS_XRP_MAINNET: 'rXRP_ADDR',
      TOKEN_NETWORK_EVM_BASE_8453: '0xTOKEN_NET_BASE',
      TOKEN_NETWORK_XRP_MAINNET: 'rTOKEN_NET_XRP',
    });

    const config = parseConfig();

    expect(config.settlementInfo?.tokenNetworks).toEqual({
      'evm:base:8453': '0xTOKEN_NET_BASE',
      'xrp:mainnet': 'rTOKEN_NET_XRP',
    });
  });

  it('tokenNetworks is undefined when no TOKEN_NETWORK_* env vars are set', () => {
    Object.assign(process.env, requiredEnv, {
      SUPPORTED_CHAINS: 'evm:base:8453',
      SETTLEMENT_ADDRESS_EVM_BASE_8453: '0xADDR',
    });

    const config = parseConfig();

    expect(config.settlementInfo?.tokenNetworks).toBeUndefined();
  });

  it('ignores empty string TOKEN_NETWORK_* env var', () => {
    Object.assign(process.env, requiredEnv, {
      SUPPORTED_CHAINS: 'evm:base:8453',
      SETTLEMENT_ADDRESS_EVM_BASE_8453: '0xADDR',
      TOKEN_NETWORK_EVM_BASE_8453: '',
    });

    const config = parseConfig();

    expect(config.settlementInfo?.tokenNetworks).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // AC #4: TOON_CHAIN env var convenience shorthand (Story 3.2)
  // --------------------------------------------------------------------------
  describe('TOON_CHAIN convenience shorthand (AC #4)', () => {
    it('derives settlementInfo from anvil chain preset when TOON_CHAIN=anvil', () => {
      Object.assign(process.env, requiredEnv, {
        TOON_CHAIN: 'anvil',
      });

      const config = parseConfig();

      expect(config.settlementInfo).toBeDefined();
      expect(config.settlementInfo?.supportedChains).toEqual([
        'evm:base:31337',
      ]);
      // Anvil preset has a non-empty tokenNetworkAddress
      expect(config.settlementInfo?.tokenNetworks).toEqual({
        'evm:base:31337': '0xCafac3dD18aC6c6e92c921884f9E4176737C052c',
      });
      expect(config.settlementInfo?.preferredTokens).toEqual({
        'evm:base:31337': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      });
    });

    it('derives settlementInfo from arbitrum-one chain preset when TOON_CHAIN=arbitrum-one', () => {
      Object.assign(process.env, requiredEnv, {
        TOON_CHAIN: 'arbitrum-one',
      });

      const config = parseConfig();

      expect(config.settlementInfo).toBeDefined();
      expect(config.settlementInfo?.supportedChains).toEqual([
        'evm:base:42161',
      ]);
      expect(config.settlementInfo?.preferredTokens).toEqual({
        'evm:base:42161': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      });
      // arbitrum-one has empty tokenNetworkAddress, so tokenNetworks should be omitted
      expect(config.settlementInfo?.tokenNetworks).toBeUndefined();
    });

    it('derives settlementInfo from arbitrum-sepolia chain preset when TOON_CHAIN=arbitrum-sepolia', () => {
      Object.assign(process.env, requiredEnv, {
        TOON_CHAIN: 'arbitrum-sepolia',
      });

      const config = parseConfig();

      expect(config.settlementInfo).toBeDefined();
      expect(config.settlementInfo?.supportedChains).toEqual([
        'evm:base:421614',
      ]);
      expect(config.settlementInfo?.preferredTokens).toEqual({
        'evm:base:421614': '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      });
      // arbitrum-sepolia has empty tokenNetworkAddress
      expect(config.settlementInfo?.tokenNetworks).toBeUndefined();
    });

    it('SUPPORTED_CHAINS takes precedence over TOON_CHAIN when both are set', () => {
      Object.assign(process.env, requiredEnv, {
        SUPPORTED_CHAINS: 'evm:base:8453',
        SETTLEMENT_ADDRESS_EVM_BASE_8453: '0xExplicitAddr',
        TOON_CHAIN: 'anvil', // should be ignored
      });

      const config = parseConfig();

      // SUPPORTED_CHAINS wins: chain key is evm:base:8453, not evm:base:31337
      expect(config.settlementInfo?.supportedChains).toEqual(['evm:base:8453']);
      expect(config.settlementInfo?.settlementAddresses).toEqual({
        'evm:base:8453': '0xExplicitAddr',
      });
    });

    it('settlementInfo is undefined when neither SUPPORTED_CHAINS nor TOON_CHAIN is set', () => {
      Object.assign(process.env, requiredEnv);

      const config = parseConfig();

      expect(config.settlementInfo).toBeUndefined();
    });

    it('TOON_RPC_URL override works through TOON_CHAIN path', () => {
      Object.assign(process.env, requiredEnv, {
        TOON_CHAIN: 'anvil',
        TOON_RPC_URL: 'https://custom-rpc.example.com',
      });

      const config = parseConfig();

      // The config is derived from the chain preset -- the RPC override
      // is handled internally by resolveChainConfig() and doesn't surface
      // in settlementInfo, but the chain preset is still resolved correctly.
      expect(config.settlementInfo).toBeDefined();
      expect(config.settlementInfo?.supportedChains).toEqual([
        'evm:base:31337',
      ]);
    });

    it('TOON_TOKEN_NETWORK override injects tokenNetwork via TOON_CHAIN path', () => {
      const customTN = '0x' + 'ab'.repeat(20);
      Object.assign(process.env, requiredEnv, {
        TOON_CHAIN: 'arbitrum-one',
        TOON_TOKEN_NETWORK: customTN,
      });

      const config = parseConfig();

      expect(config.settlementInfo).toBeDefined();
      expect(config.settlementInfo?.tokenNetworks).toEqual({
        'evm:base:42161': customTN,
      });
    });
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

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8081/admin/peers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(peerConfig),
      }
    );
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

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8081/admin/peers/nostr-aabb11cc22dd33ee',
      {
        method: 'DELETE',
      }
    );
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

describe('createChannelClient', () => {
  const adminUrl = 'http://localhost:8081';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('openChannel() sends POST to correct URL with correct body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ channelId: '0xCHANNEL', status: 'opening' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createChannelClient(adminUrl);
    const params = {
      peerId: 'nostr-aabb11cc22dd33ee',
      chain: 'evm:base:8453',
      token: '0xUSDC_TOKEN',
      tokenNetwork: '0xTOKEN_NETWORK',
      peerAddress: '0xPEER_ADDRESS',
      initialDeposit: '1000000',
      settlementTimeout: 86400,
    };

    await client.openChannel(params);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8081/admin/channels',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }
    );
  });

  it('openChannel() returns { channelId, status } from response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ channelId: '0xCHANNEL_ID', status: 'opening' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createChannelClient(adminUrl);
    const result = await client.openChannel({
      peerId: 'test-peer',
      chain: 'evm:base:8453',
      peerAddress: '0xADDR',
    });

    expect(result).toEqual({ channelId: '0xCHANNEL_ID', status: 'opening' });
  });

  it('openChannel() throws on non-OK response with status and body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createChannelClient(adminUrl);

    await expect(
      client.openChannel({
        peerId: 'test',
        chain: 'evm:base:8453',
        peerAddress: '0x1',
      })
    ).rejects.toThrow('Failed to open channel: 500 Internal Server Error');
  });

  it('getChannelState() sends GET to correct URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          channelId: '0xCH1',
          status: 'open',
          chain: 'evm:base:8453',
        }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createChannelClient(adminUrl);
    await client.getChannelState('0xCH1');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8081/admin/channels/0xCH1'
    );
  });

  it('getChannelState() returns { channelId, status, chain } from response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          channelId: '0xCH1',
          status: 'open',
          chain: 'evm:base:8453',
        }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createChannelClient(adminUrl);
    const result = await client.getChannelState('0xCH1');

    expect(result).toEqual({
      channelId: '0xCH1',
      status: 'open',
      chain: 'evm:base:8453',
    });
  });

  it('getChannelState() throws on non-OK response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createChannelClient(adminUrl);

    await expect(client.getChannelState('nonexistent')).rejects.toThrow(
      'Failed to get channel state: 404 Not Found'
    );
  });
});

describe('waitForConnector', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());

    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves immediately when health endpoint returns 200', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await waitForConnector('http://localhost:3000', {
      timeout: 5000,
      interval: 100,
    });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/health');
  });

  it('retries on fetch error until success', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await waitForConnector('http://localhost:3000', {
      timeout: 10000,
      interval: 10,
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws on timeout after max attempts', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      waitForConnector('http://localhost:3000', {
        timeout: 50,
        interval: 10,
      })
    ).rejects.toThrow(
      'Connector health check timed out after 50ms: http://localhost:3000'
    );
  });
});
