/**
 * Shared utilities for Docker entrypoints.
 *
 * Contains configuration parsing, admin client creation, and health check
 * utilities used by both the legacy entrypoint and the SDK-based entrypoint-town.
 */

import { getPublicKey } from 'nostr-tools/pure';
import type {
  ConnectorAdminClient,
  ConnectorChannelClient,
  OpenChannelParams,
  OpenChannelResult,
  ChannelState,
  SettlementConfig,
} from '@crosstown/core';

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

  const secretKeyHex = env['NOSTR_SECRET_KEY'];
  if (!secretKeyHex || secretKeyHex.length !== 64) {
    throw new Error('NOSTR_SECRET_KEY must be a 64-character hex string');
  }
  const secretKey = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
  const pubkey = getPublicKey(secretKey);

  const ilpAddress = env['ILP_ADDRESS'];
  if (!ilpAddress) {
    throw new Error('ILP_ADDRESS environment variable is required');
  }

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
  const basePricePerByte = BigInt(env['BASE_PRICE_PER_BYTE'] || '10');

  // ILP-first flow: connector URL (optional)
  const connectorUrl = env['CONNECTOR_URL'] || undefined;
  if (connectorUrl) {
    try {
      new URL(connectorUrl);
    } catch {
      throw new Error(`CONNECTOR_URL is not a valid URL: ${connectorUrl}`);
    }
  }

  // Settlement info (optional, only when SUPPORTED_CHAINS is set)
  let settlementInfo: SettlementConfig | undefined;
  const supportedChainsStr = env['SUPPORTED_CHAINS'];
  if (supportedChainsStr) {
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
