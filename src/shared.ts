/**
 * Shared utilities for Docker entrypoints.
 *
 * Contains configuration parsing, admin client creation, and health check
 * utilities used by entrypoint-sdk and entrypoint-town.
 */

import { getPublicKey } from 'nostr-tools/pure';
import { resolveChainConfig, deriveFromKmsSeed } from '@toon-protocol/core';
import type {
  ConnectorAdminClient,
  ConnectorChannelClient,
  OpenChannelParams,
  OpenChannelResult,
  ChannelState,
  SettlementConfig,
} from '@toon-protocol/core';

// Environment configuration
export interface Config {
  nodeId: string;
  secretKey: Uint8Array;
  pubkey: string;
  ilpAddress: string;
  btpEndpoint: string;
  blsPort: number;
  wsPort: number;
  connectorAdminUrl: string;
  ardriveEnabled: boolean;
  additionalPeersJson: string | undefined;
  bootstrapPeersJson: string | undefined;
  relayUrls: string[];
  assetCode: string;
  assetScale: number;
  basePricePerByte: bigint;
  connectorUrl: string | undefined;
  settlementInfo: SettlementConfig | undefined;
  initialDeposit: string | undefined;
  settlementTimeout: number | undefined;
  forgejoUrl: string | undefined;
  forgejoToken: string | undefined;
  forgejoOwner: string | undefined;
  x402Enabled: boolean;
  discoveryMode: 'seed-list' | 'genesis';
  seedRelays: string[];
  publishSeedEntry: boolean;
  externalRelayUrl: string | undefined;
}

/**
 * Parse configuration from environment variables.
 */
export function parseConfig(): Config {
  const env = process.env;

  const nodeId = env['NODE_ID'];
  if (!nodeId) {
    throw new Error('NODE_ID environment variable is required');
  }

  // Identity derivation: NOSTR_MNEMONIC (KMS pipeline) takes precedence over NOSTR_SECRET_KEY
  let secretKey: Uint8Array;
  let pubkey: string;
  const mnemonic = env['NOSTR_MNEMONIC'];
  if (mnemonic && mnemonic.trim().length > 0) {
    const keypair = deriveFromKmsSeed(new Uint8Array(32), {
      mnemonic: mnemonic.trim(),
    });
    secretKey = keypair.secretKey;
    pubkey = keypair.pubkey;
    console.log(
      `[Config] Identity derived from NOSTR_MNEMONIC via NIP-06 (pubkey: ${pubkey.slice(0, 16)}...)`
    );
  } else {
    const secretKeyHex = env['NOSTR_SECRET_KEY'];
    if (!secretKeyHex || secretKeyHex.length !== 64) {
      throw new Error(
        'NOSTR_MNEMONIC or NOSTR_SECRET_KEY must be set (NOSTR_SECRET_KEY must be a 64-character hex string)'
      );
    }
    secretKey = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
    pubkey = getPublicKey(secretKey);
    console.log(
      `[Config] Identity from NOSTR_SECRET_KEY (pubkey: ${pubkey.slice(0, 16)}...)`
    );
  }

  const ilpAddress = env['ILP_ADDRESS'];
  if (!ilpAddress) {
    throw new Error('ILP_ADDRESS environment variable is required');
  }

  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- BTP default for internal Docker network (container-to-container)
  const btpEndpoint = env['BTP_ENDPOINT'] || `ws://${nodeId}:3000`;

  const blsPort = parseInt(env['BLS_PORT'] || '3100', 10);
  const wsPort = parseInt(env['WS_PORT'] || '7100', 10);

  const connectorAdminUrl =
    env['CONNECTOR_ADMIN_URL'] || `http://${nodeId}:8081`;

  const ardriveEnabled = env['ARDRIVE_ENABLED'] !== 'false';
  const additionalPeersJson = env['ADDITIONAL_PEERS'] || undefined;
  const bootstrapPeersJson = env['BOOTSTRAP_PEERS'] || undefined;
  const relayUrls = [`ws://localhost:${wsPort}`];

  const assetCode = env['ASSET_CODE'] || 'USD';
  const assetScale = parseInt(env['ASSET_SCALE'] || '6', 10);
  const basePricePerByte = BigInt(env['BASE_PRICE_PER_BYTE'] || '1');

  // ILP-first flow: connector URL (optional)
  const connectorUrl = env['CONNECTOR_URL'] || undefined;
  if (connectorUrl) {
    try {
      new URL(connectorUrl);
    } catch {
      throw new Error(`CONNECTOR_URL is not a valid URL: ${connectorUrl}`);
    }
  }

  // Settlement info (optional)
  // Priority: SUPPORTED_CHAINS (explicit) > TOON_CHAIN (convenience preset)
  let settlementInfo: SettlementConfig | undefined;
  const supportedChainsStr = env['SUPPORTED_CHAINS'];
  if (supportedChainsStr) {
    // Explicit env var pattern: SUPPORTED_CHAINS + per-chain env vars
    const supportedChains = supportedChainsStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const settlementAddresses: Record<string, string> = {};
    const preferredTokens: Record<string, string> = {};
    const tokenNetworks: Record<string, string> = {};

    for (const chain of supportedChains) {
      // Convert chain id to env var key: "evm:base:8453" -> "EVM_BASE_8453"
      const envKey = chain.replace(/:/g, '_').toUpperCase();
      const addr = env[`SETTLEMENT_ADDRESS_${envKey}`];
      if (addr) settlementAddresses[chain] = addr;
      const token = env[`PREFERRED_TOKEN_${envKey}`];
      if (token) preferredTokens[chain] = token;
      const tokenNet = env[`TOKEN_NETWORK_${envKey}`];
      if (tokenNet) tokenNetworks[chain] = tokenNet;
    }

    // Warn for chains without a settlement address
    for (const chain of supportedChains) {
      if (!settlementAddresses[chain]) {
        console.warn(
          `[Config] Warning: chain "${chain}" listed in SUPPORTED_CHAINS but no SETTLEMENT_ADDRESS_* env var found`
        );
      }
    }

    settlementInfo = {
      supportedChains,
      ...(Object.keys(settlementAddresses).length > 0 && {
        settlementAddresses,
      }),
      ...(Object.keys(preferredTokens).length > 0 && { preferredTokens }),
      ...(Object.keys(tokenNetworks).length > 0 && { tokenNetworks }),
    };
  } else if (env['TOON_CHAIN']) {
    // Convenience shorthand: derive settlement config from a chain preset.
    // TOON_RPC_URL and TOON_TOKEN_NETWORK overrides are handled
    // internally by resolveChainConfig().
    const chainConfig = resolveChainConfig(env['TOON_CHAIN']);
    const chainKey = `evm:base:${chainConfig.chainId}`;

    const preferredTokens: Record<string, string> = {
      [chainKey]: chainConfig.usdcAddress,
    };
    const tokenNetworks: Record<string, string> = {};
    if (chainConfig.tokenNetworkAddress) {
      tokenNetworks[chainKey] = chainConfig.tokenNetworkAddress;
    }

    settlementInfo = {
      supportedChains: [chainKey],
      ...(Object.keys(preferredTokens).length > 0 && { preferredTokens }),
      ...(Object.keys(tokenNetworks).length > 0 && { tokenNetworks }),
    };
  }

  // Initial deposit for payment channels (optional)
  let initialDeposit: string | undefined;
  const initialDepositStr = env['INITIAL_DEPOSIT'];
  if (initialDepositStr !== undefined && initialDepositStr !== '') {
    if (!/^\d+$/.test(initialDepositStr)) {
      throw new Error(
        `INITIAL_DEPOSIT must be a non-negative integer string: ${initialDepositStr}`
      );
    }
    initialDeposit = initialDepositStr;
  }

  // Settlement timeout in seconds (optional)
  let settlementTimeout: number | undefined;
  const settlementTimeoutStr = env['SETTLEMENT_TIMEOUT'];
  if (settlementTimeoutStr !== undefined && settlementTimeoutStr !== '') {
    const parsed = parseInt(settlementTimeoutStr, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(
        `SETTLEMENT_TIMEOUT must be a positive integer: ${settlementTimeoutStr}`
      );
    }
    settlementTimeout = parsed;
  }

  // NIP-34 Git Integration (Forgejo) - optional
  const forgejoUrl = env['FORGEJO_URL'];
  const forgejoToken = env['FORGEJO_TOKEN'];
  const forgejoOwner = env['FORGEJO_OWNER'];

  // x402 publish endpoint (default: disabled)
  const x402Enabled = env['TOON_X402_ENABLED'] === 'true';

  // Seed relay discovery (default: genesis mode)
  const discoveryRaw = env['TOON_DISCOVERY'] ?? 'genesis';
  if (discoveryRaw !== 'seed-list' && discoveryRaw !== 'genesis') {
    throw new Error(
      `TOON_DISCOVERY must be "seed-list" or "genesis", got: "${discoveryRaw}"`
    );
  }
  const discoveryMode: 'seed-list' | 'genesis' = discoveryRaw;
  const seedRelaysStr = env['TOON_SEED_RELAYS'];
  const seedRelays = seedRelaysStr
    ? seedRelaysStr
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Validate seed relay URLs have WebSocket scheme
  for (const url of seedRelays) {
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- validation check, not a connection
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- error message text, not a connection
      throw new Error(
        'TOON_SEED_RELAYS contains invalid URL -- must use WebSocket scheme (ws or wss)'
      );
    }
  }
  const publishSeedEntry = env['TOON_PUBLISH_SEED_ENTRY'] === 'true';
  const externalRelayUrl = env['TOON_EXTERNAL_RELAY_URL'] || undefined;

  return {
    nodeId,
    secretKey,
    pubkey,
    ilpAddress,
    btpEndpoint,
    blsPort,
    wsPort,
    connectorAdminUrl,
    ardriveEnabled,
    additionalPeersJson,
    bootstrapPeersJson,
    relayUrls,
    assetCode,
    assetScale,
    basePricePerByte,
    connectorUrl,
    settlementInfo,
    initialDeposit,
    settlementTimeout,
    forgejoUrl,
    forgejoToken,
    forgejoOwner,
    x402Enabled,
    discoveryMode,
    seedRelays,
    publishSeedEntry,
    externalRelayUrl,
  };
}

/**
 * Docker-specific admin client interface with required removePeer.
 * Extends ConnectorAdminClient making removePeer non-optional since
 * the Docker entrypoint always implements both addPeer and removePeer.
 */
export interface DockerConnectorAdminClient extends ConnectorAdminClient {
  removePeer(peerId: string): Promise<void>;
}

/**
 * Create an HTTP connector admin client matching the ConnectorAdminClient interface.
 */
export function createConnectorAdminClient(
  adminUrl: string
): DockerConnectorAdminClient {
  return {
    async addPeer(config: {
      id: string;
      url: string;
      authToken?: string;
      routes?: { prefix: string; priority?: number }[];
    }): Promise<void> {
      // Ensure authToken is a string (empty string for permissionless)
      const payload = {
        id: config.id,
        url: config.url,
        authToken: typeof config.authToken === 'string' ? config.authToken : '',
        ...(config.routes && { routes: config.routes }),
      };

      const response = await fetch(`${adminUrl}/admin/peers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to add peer: ${response.status} ${text}`);
      }
    },

    async removePeer(peerId: string): Promise<void> {
      const response = await fetch(`${adminUrl}/admin/peers/${peerId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to remove peer: ${response.status} ${text}`);
      }
    },
  };
}

/**
 * Create an HTTP channel client matching the ConnectorChannelClient interface.
 * Calls the connector Admin API to open/query payment channels.
 */
export function createChannelClient(
  connectorAdminUrl: string
): ConnectorChannelClient {
  return {
    async openChannel(params: OpenChannelParams): Promise<OpenChannelResult> {
      const response = await fetch(`${connectorAdminUrl}/admin/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to open channel: ${response.status} ${text}`);
      }

      return (await response.json()) as OpenChannelResult;
    },

    async getChannelState(channelId: string): Promise<ChannelState> {
      const response = await fetch(
        `${connectorAdminUrl}/admin/channels/${channelId}`
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Failed to get channel state: ${response.status} ${text}`
        );
      }

      return (await response.json()) as ChannelState;
    },
  };
}

/**
 * Wait for connector health endpoint to become available.
 */
export async function waitForConnector(
  url: string,
  options?: { timeout?: number; interval?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 60000;
  const interval = options?.interval ?? 2000;
  const healthUrl = `${url}/health`;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
      console.log(
        `[Bootstrap] Connector not ready (HTTP ${response.status}), retrying...`
      );
    } catch {
      console.log(
        `[Bootstrap] Connector not reachable at ${healthUrl}, retrying...`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Connector health check timed out after ${timeout}ms: ${url}`
  );
}

/**
 * @deprecated Use waitForConnector instead
 */
export const waitForAgentRuntime = waitForConnector;
