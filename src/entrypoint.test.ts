import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock nostr-tools/pure to avoid native crypto dependency in tests
vi.mock('nostr-tools/pure', () => ({
  getPublicKey: vi.fn(() => 'a'.repeat(64)),
}));

// Hoisted mock functions (must be hoisted for vi.mock factory)
const {
  mockParseSpspRequest,
  mockBuildSpspResponseEvent,
  mockNegotiateAndOpenChannel,
  mockDecodeEventFromToon,
  mockEncodeEventToToon,
  mockGenerateFulfillment,
} = vi.hoisted(() => ({
  mockParseSpspRequest: vi.fn(),
  mockBuildSpspResponseEvent: vi.fn(),
  mockNegotiateAndOpenChannel: vi.fn(),
  mockDecodeEventFromToon: vi.fn(),
  mockEncodeEventToToon: vi.fn(),
  mockGenerateFulfillment: vi.fn(),
}));

// Mock @crosstown/core — keep real types/constants, mock functions used by createBlsServer
vi.mock('@crosstown/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    parseSpspRequest: mockParseSpspRequest,
    buildSpspResponseEvent: mockBuildSpspResponseEvent,
    negotiateAndOpenChannel: mockNegotiateAndOpenChannel,
  };
});

// Mock @crosstown/relay — keep real ILP_ERROR_CODES/PricingService, mock encode/decode
vi.mock('@crosstown/relay', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    decodeEventFromToon: mockDecodeEventFromToon,
    encodeEventToToon: mockEncodeEventToToon,
    generateFulfillment: mockGenerateFulfillment,
  };
});

import { parseConfig, createConnectorAdminClient, createChannelClient, waitForAgentRuntime, createBlsServer, type Config } from './entrypoint.js';
import { SPSP_REQUEST_KIND } from '@crosstown/core';
import { PricingService, ILP_ERROR_CODES } from '@crosstown/relay';

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
    'SPSP_MIN_PRICE',
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

  it('throws when CONNECTOR_URL is not a valid URL', () => {
    Object.assign(process.env, requiredEnv, { CONNECTOR_URL: 'not-a-url' });

    expect(() => parseConfig()).toThrow('CONNECTOR_URL is not a valid URL: not-a-url');
  });

  it('accepts valid CONNECTOR_URL and stores in config', () => {
    Object.assign(process.env, requiredEnv, { CONNECTOR_URL: 'http://localhost:3000' });

    const config = parseConfig();

    expect(config.connectorUrl).toBe('http://localhost:3000');
  });

  it('parses SPSP_MIN_PRICE=0 as 0n bigint', () => {
    Object.assign(process.env, requiredEnv, { SPSP_MIN_PRICE: '0' });

    const config = parseConfig();

    expect(config.spspMinPrice).toBe(0n);
  });

  it('parses SPSP_MIN_PRICE=5 as 5n bigint', () => {
    Object.assign(process.env, requiredEnv, { SPSP_MIN_PRICE: '5' });

    const config = parseConfig();

    expect(config.spspMinPrice).toBe(5n);
  });

  it('defaults spspMinPrice to undefined when SPSP_MIN_PRICE is not set', () => {
    Object.assign(process.env, requiredEnv);

    const config = parseConfig();

    expect(config.spspMinPrice).toBeUndefined();
  });

  it('throws when SPSP_MIN_PRICE is not a valid integer', () => {
    Object.assign(process.env, requiredEnv, { SPSP_MIN_PRICE: 'abc' });

    expect(() => parseConfig()).toThrow('SPSP_MIN_PRICE is not a valid integer: abc');
  });

  it('parses SUPPORTED_CHAINS with settlement address into settlementInfo', () => {
    Object.assign(process.env, requiredEnv, {
      SUPPORTED_CHAINS: 'evm:base:8453',
      SETTLEMENT_ADDRESS_EVM_BASE_8453: '0x1234567890abcdef',
    });

    const config = parseConfig();

    expect(config.settlementInfo).toBeDefined();
    expect(config.settlementInfo?.supportedChains).toEqual(['evm:base:8453']);
    expect(config.settlementInfo?.settlementAddresses).toEqual({ 'evm:base:8453': '0x1234567890abcdef' });
  });

  it('logs warning when SUPPORTED_CHAINS has chain without settlement address', () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(process.env, requiredEnv, {
      SUPPORTED_CHAINS: 'evm:base:8453',
    });

    parseConfig();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('chain "evm:base:8453" listed in SUPPORTED_CHAINS but no SETTLEMENT_ADDRESS_*')
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

    expect(() => parseConfig()).toThrow('INITIAL_DEPOSIT must be a non-negative integer string: abc');
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
    Object.assign(process.env, requiredEnv, { SETTLEMENT_TIMEOUT: 'not-a-number' });

    expect(() => parseConfig()).toThrow('SETTLEMENT_TIMEOUT must be a positive integer: not-a-number');
  });

  it('parses single TOKEN_NETWORK_* env var into settlementInfo.tokenNetworks', () => {
    Object.assign(process.env, requiredEnv, {
      SUPPORTED_CHAINS: 'evm:base:8453',
      SETTLEMENT_ADDRESS_EVM_BASE_8453: '0xADDR',
      TOKEN_NETWORK_EVM_BASE_8453: '0xTOKEN_NET',
    });

    const config = parseConfig();

    expect(config.settlementInfo?.tokenNetworks).toEqual({ 'evm:base:8453': '0xTOKEN_NET' });
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
      json: () => Promise.resolve({ channelId: '0xCHANNEL', status: 'opening' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createChannelClient(adminUrl);
    const params = {
      peerId: 'nostr-aabb11cc22dd33ee',
      chain: 'evm:base:8453',
      token: '0xAGENT_TOKEN',
      tokenNetwork: '0xTOKEN_NETWORK',
      peerAddress: '0xPEER_ADDRESS',
      initialDeposit: '1000000',
      settlementTimeout: 86400,
    };

    await client.openChannel(params);

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8081/admin/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  });

  it('openChannel() returns { channelId, status } from response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ channelId: '0xCHANNEL_ID', status: 'opening' }),
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
      client.openChannel({ peerId: 'test', chain: 'evm:base:8453', peerAddress: '0x1' })
    ).rejects.toThrow('Failed to open channel: 500 Internal Server Error');
  });

  it('getChannelState() sends GET to correct URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ channelId: '0xCH1', status: 'open', chain: 'evm:base:8453' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createChannelClient(adminUrl);
    await client.getChannelState('0xCH1');

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8081/admin/channels/0xCH1');
  });

  it('getChannelState() returns { channelId, status, chain } from response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ channelId: '0xCH1', status: 'open', chain: 'evm:base:8453' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createChannelClient(adminUrl);
    const result = await client.getChannelState('0xCH1');

    expect(result).toEqual({ channelId: '0xCH1', status: 'open', chain: 'evm:base:8453' });
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

describe('waitForAgentRuntime', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves immediately when health endpoint returns 200', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await waitForAgentRuntime('http://localhost:3000', { timeout: 5000, interval: 100 });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/health');
  });

  it('retries on fetch error until success', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await waitForAgentRuntime('http://localhost:3000', { timeout: 10000, interval: 10 });

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws on timeout after max attempts', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      waitForAgentRuntime('http://localhost:3000', { timeout: 50, interval: 10 })
    ).rejects.toThrow('Agent-runtime health check timed out after 50ms: http://localhost:3000');
  });
});

describe('createBlsServer /handle-packet settlement', () => {
  const SENDER_PUBKEY = 'b'.repeat(64);

  const testConfig: Config = {
    nodeId: 'test-node',
    secretKey: Uint8Array.from(Buffer.from('a'.repeat(64), 'hex')),
    pubkey: 'a'.repeat(64),
    ilpAddress: 'g.test',
    btpEndpoint: 'ws://test-node:3000',
    blsPort: 3100,
    wsPort: 7100,
    connectorAdminUrl: 'http://test-node:8081',
    ardriveEnabled: true,
    additionalPeersJson: undefined,
    relayUrls: ['ws://localhost:7100'],
    assetCode: 'USD',
    assetScale: 6,
    basePricePerByte: 10n,
    connectorUrl: undefined,
    settlementInfo: undefined,
    initialDeposit: undefined,
    settlementTimeout: undefined,
    spspMinPrice: 0n,
  };

  const mockSettlementConfig = {
    ownSupportedChains: ['evm:base:8453'],
    ownSettlementAddresses: { 'evm:base:8453': '0xOWN_ADDRESS' },
    ownPreferredTokens: { 'evm:base:8453': '0xTOKEN' },
    ownTokenNetworks: undefined,
    initialDeposit: '0',
    settlementTimeout: 86400,
    channelOpenTimeout: 30000,
    pollInterval: 1000,
  };

  const mockChannelClient = {
    openChannel: vi.fn(),
    getChannelState: vi.fn(),
  };

  const mockAdminClient = {
    addPeer: vi.fn().mockResolvedValue(undefined),
  };

  // Helper: build a valid /handle-packet request body with a kind:23194 SPSP event
  function buildSpspPaymentBody(amount = '100') {
    return {
      amount,
      destination: 'g.test.spsp.abc123',
      data: Buffer.from('toon-encoded-data').toString('base64'),
    };
  }

  // Fake TOON-decoded event simulating kind:23194
  const fakeSpspEvent = {
    id: 'event-id-123',
    pubkey: SENDER_PUBKEY,
    kind: SPSP_REQUEST_KIND,
    content: 'encrypted-content',
    tags: [['p', 'a'.repeat(64)]],
    created_at: Math.floor(Date.now() / 1000),
    sig: 'fake-sig',
  };

  let pricingService: PricingService;

  beforeEach(() => {
    vi.resetAllMocks();

    // Set up mocks for the encode/decode pipeline
    mockDecodeEventFromToon.mockReturnValue(fakeSpspEvent);
    mockEncodeEventToToon.mockReturnValue(new Uint8Array([1, 2, 3]));

    mockBuildSpspResponseEvent.mockReturnValue({
      id: 'response-event-id',
      pubkey: 'a'.repeat(64),
      kind: 23195,
      content: 'encrypted-response',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: 'fake-sig',
    });

    // Set up pricing service with 0 price for SPSP
    pricingService = new PricingService({
      basePricePerByte: 10n,
      kindOverrides: new Map([[SPSP_REQUEST_KIND, 0n]]),
    });
  });

  it('SPSP request with settlement fields triggers negotiation', async () => {
    mockParseSpspRequest.mockReturnValue({
      requestId: 'req-1',
      timestamp: Date.now(),
      supportedChains: ['evm:base:8453'],
      settlementAddresses: { 'evm:base:8453': '0xPEER_ADDR' },
      preferredTokens: { 'evm:base:8453': '0xTOKEN' },
    });
    mockNegotiateAndOpenChannel.mockResolvedValue({
      negotiatedChain: 'evm:base:8453',
      settlementAddress: '0xOWN_ADDRESS',
      tokenAddress: '0xTOKEN',
      tokenNetworkAddress: undefined,
      channelId: '0xCHANNEL1',
      settlementTimeout: 86400,
    });

    const mockEventStore = { store: vi.fn() };
    const app = createBlsServer(
      testConfig, mockEventStore as never, pricingService, undefined,
      mockSettlementConfig, mockChannelClient, mockAdminClient
    );

    const res = await app.request('/handle-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSpspPaymentBody()),
    });

    expect(res.status).toBe(200);
    expect(mockNegotiateAndOpenChannel).toHaveBeenCalledTimes(1);
    // Verify the SPSP response event was built with settlement fields
    expect(mockBuildSpspResponseEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        negotiatedChain: 'evm:base:8453',
        settlementAddress: '0xOWN_ADDRESS',
        channelId: '0xCHANNEL1',
      }),
      SENDER_PUBKEY,
      testConfig.secretKey,
      'event-id-123'
    );
  });

  it('SPSP response includes settlement fields when channel opened', async () => {
    mockParseSpspRequest.mockReturnValue({
      requestId: 'req-2',
      timestamp: Date.now(),
      supportedChains: ['evm:base:8453'],
      settlementAddresses: { 'evm:base:8453': '0xPEER_ADDR' },
    });
    mockNegotiateAndOpenChannel.mockResolvedValue({
      negotiatedChain: 'evm:base:8453',
      settlementAddress: '0xOWN_ADDRESS',
      tokenAddress: '0xTOKEN',
      tokenNetworkAddress: '0xTOKEN_NET',
      channelId: '0xCH2',
      settlementTimeout: 86400,
    });

    const mockEventStore = { store: vi.fn() };
    const app = createBlsServer(
      testConfig, mockEventStore as never, pricingService, undefined,
      mockSettlementConfig, mockChannelClient, mockAdminClient
    );

    const res = await app.request('/handle-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSpspPaymentBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accept).toBe(true);
    expect(body.data).toBeDefined();

    // Check that buildSpspResponseEvent received settlement fields
    const spspResponseArg = mockBuildSpspResponseEvent.mock.calls[0][0];
    expect(spspResponseArg.negotiatedChain).toBe('evm:base:8453');
    expect(spspResponseArg.settlementAddress).toBe('0xOWN_ADDRESS');
    expect(spspResponseArg.tokenAddress).toBe('0xTOKEN');
    expect(spspResponseArg.tokenNetworkAddress).toBe('0xTOKEN_NET');
    expect(spspResponseArg.channelId).toBe('0xCH2');
    expect(spspResponseArg.settlementTimeout).toBe(86400);
  });

  it('SPSP request without settlement fields returns basic response (backward compat)', async () => {
    mockParseSpspRequest.mockReturnValue({
      requestId: 'req-3',
      timestamp: Date.now(),
      // No supportedChains — basic request
    });

    const mockEventStore = { store: vi.fn() };
    const app = createBlsServer(
      testConfig, mockEventStore as never, pricingService, undefined,
      mockSettlementConfig, mockChannelClient, mockAdminClient
    );

    const res = await app.request('/handle-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSpspPaymentBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accept).toBe(true);
    // negotiateAndOpenChannel should NOT be called
    expect(mockNegotiateAndOpenChannel).not.toHaveBeenCalled();
    // buildSpspResponseEvent should be called with basic fields only
    const spspResponseArg = mockBuildSpspResponseEvent.mock.calls[0][0];
    expect(spspResponseArg.negotiatedChain).toBeUndefined();
    expect(spspResponseArg.channelId).toBeUndefined();
  });

  it('channel open failure returns REJECT response', async () => {
    mockParseSpspRequest.mockReturnValue({
      requestId: 'req-4',
      timestamp: Date.now(),
      supportedChains: ['evm:base:8453'],
      settlementAddresses: { 'evm:base:8453': '0xPEER_ADDR' },
    });
    mockNegotiateAndOpenChannel.mockRejectedValue(new Error('Channel open failed'));

    const mockEventStore = { store: vi.fn() };
    const app = createBlsServer(
      testConfig, mockEventStore as never, pricingService, undefined,
      mockSettlementConfig, mockChannelClient, mockAdminClient
    );

    const res = await app.request('/handle-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSpspPaymentBody()),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.accept).toBe(false);
    expect(body.code).toBe(ILP_ERROR_CODES.INTERNAL_ERROR);
    expect(body.message).toContain('Channel open failed');
  });

  it('no settlement config returns basic response regardless of request fields', async () => {
    mockParseSpspRequest.mockReturnValue({
      requestId: 'req-5',
      timestamp: Date.now(),
      supportedChains: ['evm:base:8453'],
      settlementAddresses: { 'evm:base:8453': '0xPEER_ADDR' },
    });

    const mockEventStore = { store: vi.fn() };
    // No settlementConfig or channelClient passed
    const app = createBlsServer(
      testConfig, mockEventStore as never, pricingService
    );

    const res = await app.request('/handle-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSpspPaymentBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accept).toBe(true);
    // negotiateAndOpenChannel should NOT be called
    expect(mockNegotiateAndOpenChannel).not.toHaveBeenCalled();
  });

  it('SPSP response does NOT contain fulfillment field', async () => {
    mockParseSpspRequest.mockReturnValue({
      requestId: 'req-no-ful-1',
      timestamp: Date.now(),
    });

    const mockEventStore = { store: vi.fn() };
    const app = createBlsServer(
      testConfig, mockEventStore as never, pricingService
    );

    const res = await app.request('/handle-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSpspPaymentBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accept).toBe(true);
    expect(body).not.toHaveProperty('fulfillment');
  });

  it('generic event response does NOT contain fulfillment field', async () => {
    // Use a non-SPSP event kind (kind:1 = text note)
    const genericEvent = {
      id: 'event-generic-123',
      pubkey: SENDER_PUBKEY,
      kind: 1,
      content: 'hello world',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: 'fake-sig',
    };
    mockDecodeEventFromToon.mockReturnValue(genericEvent);

    const mockEventStore = { store: vi.fn() };
    const app = createBlsServer(
      testConfig, mockEventStore as never, pricingService
    );

    const res = await app.request('/handle-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: '10000',
        destination: 'g.test',
        data: Buffer.from('toon-encoded-data').toString('base64'),
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accept).toBe(true);
    expect(body).not.toHaveProperty('fulfillment');
  });
});

describe('SPSP path equivalence (AC: 9)', () => {
  const SENDER_PUBKEY = 'b'.repeat(64);

  const testConfig: Config = {
    nodeId: 'test-node',
    secretKey: Uint8Array.from(Buffer.from('a'.repeat(64), 'hex')),
    pubkey: 'a'.repeat(64),
    ilpAddress: 'g.test',
    btpEndpoint: 'ws://test-node:3000',
    blsPort: 3100,
    wsPort: 7100,
    connectorAdminUrl: 'http://test-node:8081',
    ardriveEnabled: true,
    additionalPeersJson: undefined,
    relayUrls: ['ws://localhost:7100'],
    assetCode: 'USD',
    assetScale: 6,
    basePricePerByte: 10n,
    connectorUrl: undefined,
    settlementInfo: undefined,
    initialDeposit: undefined,
    settlementTimeout: undefined,
    spspMinPrice: 0n,
  };

  const settlementConfig = {
    ownSupportedChains: ['evm:base:8453'],
    ownSettlementAddresses: { 'evm:base:8453': '0xOWN_ADDRESS' },
    ownPreferredTokens: { 'evm:base:8453': '0xTOKEN' },
    ownTokenNetworks: undefined,
    initialDeposit: '0',
    settlementTimeout: 86400,
    channelOpenTimeout: 30000,
    pollInterval: 1000,
  };

  const settlementResult = {
    negotiatedChain: 'evm:base:8453',
    settlementAddress: '0xOWN_ADDRESS',
    tokenAddress: '0xTOKEN',
    tokenNetworkAddress: undefined,
    channelId: '0xCHANNEL_EQ',
    settlementTimeout: 86400,
  };

  const spspRequest = {
    requestId: 'req-eq-1',
    timestamp: Date.now(),
    supportedChains: ['evm:base:8453'],
    settlementAddresses: { 'evm:base:8453': '0xPEER_ADDR' },
    preferredTokens: { 'evm:base:8453': '0xTOKEN' },
    ilpAddress: 'g.peer1',
  };

  const fakeSpspEvent = {
    id: 'event-eq-123',
    pubkey: SENDER_PUBKEY,
    kind: SPSP_REQUEST_KIND,
    content: 'encrypted-content',
    tags: [['p', 'a'.repeat(64)]],
    created_at: Math.floor(Date.now() / 1000),
    sig: 'fake-sig',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockDecodeEventFromToon.mockReturnValue(fakeSpspEvent);
    mockEncodeEventToToon.mockReturnValue(new Uint8Array([1, 2, 3]));

    mockBuildSpspResponseEvent.mockReturnValue({
      id: 'resp-eq-id',
      pubkey: 'a'.repeat(64),
      kind: 23195,
      content: 'encrypted-response',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: 'fake-sig',
    });
  });

  it('both SPSP paths produce equivalent settlement results for the same inputs', async () => {
    // Configure mock to return same settlement result for both calls
    mockNegotiateAndOpenChannel.mockResolvedValue(settlementResult);
    mockParseSpspRequest.mockReturnValue(spspRequest);

    const pricingService = new PricingService({
      basePricePerByte: 10n,
      kindOverrides: new Map([[SPSP_REQUEST_KIND, 0n]]),
    });

    const mockEventStore = { store: vi.fn() };
    const mockChannelClient = { openChannel: vi.fn(), getChannelState: vi.fn() };
    const mockAdminClient = { addPeer: vi.fn().mockResolvedValue(undefined) };

    // BLS path: invoke /handle-packet
    const app = createBlsServer(
      testConfig, mockEventStore as never, pricingService, undefined,
      settlementConfig, mockChannelClient, mockAdminClient
    );

    const res = await app.request('/handle-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: '100',
        destination: 'g.test.spsp.abc123',
        data: Buffer.from('toon-encoded-data').toString('base64'),
      }),
    });

    expect(res.status).toBe(200);

    // Verify negotiateAndOpenChannel was called with expected params
    expect(mockNegotiateAndOpenChannel).toHaveBeenCalledTimes(1);
    const callArgs = mockNegotiateAndOpenChannel.mock.calls[0][0];

    // These are the same params that NostrSpspServer.negotiateSettlement() passes
    // (verified by code review — both call negotiateAndOpenChannel with request, config, channelClient, senderPubkey)
    expect(callArgs.request).toEqual(spspRequest);
    expect(callArgs.config).toEqual(settlementConfig);
    expect(callArgs.channelClient).toBe(mockChannelClient);
    expect(callArgs.senderPubkey).toBe(SENDER_PUBKEY);

    // Verify the SPSP response includes all settlement fields
    const spspResponseArg = mockBuildSpspResponseEvent.mock.calls[0][0];
    expect(spspResponseArg.negotiatedChain).toBe('evm:base:8453');
    expect(spspResponseArg.settlementAddress).toBe('0xOWN_ADDRESS');
    expect(spspResponseArg.tokenAddress).toBe('0xTOKEN');
    expect(spspResponseArg.channelId).toBe('0xCHANNEL_EQ');
    expect(spspResponseArg.settlementTimeout).toBe(86400);
  });
});

describe('createBlsServer /health peer/channel counts', () => {
  const testConfig: Config = {
    nodeId: 'test-node',
    secretKey: Uint8Array.from(Buffer.from('a'.repeat(64), 'hex')),
    pubkey: 'a'.repeat(64),
    ilpAddress: 'g.test',
    btpEndpoint: 'ws://test-node:3000',
    blsPort: 3100,
    wsPort: 7100,
    connectorAdminUrl: 'http://test-node:8081',
    ardriveEnabled: true,
    additionalPeersJson: undefined,
    relayUrls: ['ws://localhost:7100'],
    assetCode: 'USD',
    assetScale: 6,
    basePricePerByte: 10n,
    connectorUrl: undefined,
    settlementInfo: undefined,
    initialDeposit: undefined,
    settlementTimeout: undefined,
    spspMinPrice: 0n,
  };

  it('returns peerCount and channelCount when bootstrap phase is ready', async () => {
    const mockEventStore = { store: vi.fn() };
    const pricingService = new PricingService({ basePricePerByte: 10n });

    const app = createBlsServer(
      testConfig, mockEventStore as never, pricingService,
      () => 'ready',
      undefined, undefined, undefined,
      () => ({ peerCount: 3, channelCount: 2 })
    );

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.bootstrapPhase).toBe('ready');
    expect(body.peerCount).toBe(3);
    expect(body.channelCount).toBe(2);
  });

  it('omits peerCount and channelCount when bootstrap phase is not ready', async () => {
    const mockEventStore = { store: vi.fn() };
    const pricingService = new PricingService({ basePricePerByte: 10n });

    const app = createBlsServer(
      testConfig, mockEventStore as never, pricingService,
      () => 'discovering',
      undefined, undefined, undefined,
      () => ({ peerCount: 1, channelCount: 0 })
    );

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.bootstrapPhase).toBe('discovering');
    expect(body).not.toHaveProperty('peerCount');
    expect(body).not.toHaveProperty('channelCount');
  });
});
