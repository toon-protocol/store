/**
 * Townhouse API Container Entrypoint
 *
 * Starts ONLY the Fastify API server — no Docker orchestration bootstrap.
 * The Docker socket is mounted at /var/run/docker.sock at runtime (Story 45.4).
 *
 * Environment variables:
 *   TOWNHOUSE_CONFIG           — path to config.yaml (default: /config/config.yaml)
 *   TOWNHOUSE_WALLET_PASSWORD  — wallet decryption password
 *   TOWNHOUSE_API_HOST         — override bind host (default: 0.0.0.0 in container)
 *   TOWNHOUSE_API_PORT         — override bind port (default: 28090)
 *   TOON_RPC_URL               — EVM RPC endpoint (passed to viem chain config)
 *   SOLANA_RPC_URL             — Solana RPC endpoint
 *   TOON_USDC_ADDRESS          — ERC-20 USDC contract address
 *
 * Docker build command (from repo root):
 *   docker build -f docker/Dockerfile.townhouse-api -t toon:townhouse-api .
 */

import Docker from 'dockerode';

import {
  loadConfig,
  WalletManager,
  loadWallet,
  decryptWallet,
  ConnectorAdminClient,
  TransportProbe,
  DEFAULT_ATOR_PROXY,
  DockerOrchestrator,
  createApiServer,
} from '@toon-protocol/townhouse';

const configPath =
  process.env['TOWNHOUSE_CONFIG'] ?? '/config/config.yaml';

const password = process.env['TOWNHOUSE_WALLET_PASSWORD'];
if (!password) {
  console.error(
    '[townhouse-api] TOWNHOUSE_WALLET_PASSWORD is required in container mode'
  );
  process.exit(1);
}

console.log(`[townhouse-api] config: ${configPath}`);

let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  console.error(
    `[townhouse-api] failed to load config from ${configPath}:`,
    (err as Error).message
  );
  process.exit(1);
}

const walletPath = config.wallet.encrypted_path;
console.log(`[townhouse-api] wallet: ${walletPath}`);

const loaded = await loadWallet(walletPath);
if (!loaded) {
  console.error(`[townhouse-api] No wallet at ${walletPath}.`);
  process.exit(1);
}
if (loaded.permissionsWarning) {
  console.warn(loaded.permissionsWarning);
}

const mnemonic = decryptWallet(loaded.wallet, password);
const walletManager = new WalletManager({ encryptedPath: walletPath });
await walletManager.fromMnemonic(mnemonic);
console.log('[townhouse-api] wallet decrypted');

const docker = new Docker();

// Construct the HS-profile orchestrator. `compose/townhouse-hs.yml` is written
// by handleHsUp on the host (via materializeComposeTemplate('hs', {townhouseHome:configDir}))
// and reaches the container at /.townhouse/compose/townhouse-hs.yml via the
// ${TOWNHOUSE_HOME}:/.townhouse:rw bind mount. The default 'dev' profile would
// fail `startNodeViaCompose` with OrchestratorError on the first /api/nodes POST.
// Discovered by Story 46.4 live gate run (Finding F, 2026-05-11).
const composePath = '/.townhouse/compose/townhouse-hs.yml';
const orchestrator = new DockerOrchestrator(docker, config, walletManager, {
  profile: 'hs',
  composePath,
});

// Connector admin URL — 127.0.0.1 inside a container resolves to THIS
// container's loopback, not the host's and not the connector's. Both
// containers share the `townhouse-hs-net` Docker network, and the connector
// has `hostname: connector` per the compose template, so Docker DNS resolves
// the right peer. Discovered by Story 46.4 live gate run (Finding G,
// 2026-05-11). Override via env var for non-default deployments.
const connectorHost =
  process.env['TOWNHOUSE_CONNECTOR_HOST'] ?? 'connector';
const connectorAdmin = new ConnectorAdminClient(
  `http://${connectorHost}:${config.connector.adminPort}`
);
console.log(
  `[townhouse-api] connector admin: http://${connectorHost}:${config.connector.adminPort}`
);

const transportProbe = new TransportProbe({
  proxyUrl:
    config.transport.mode === 'ator'
      ? config.transport.socksProxy ?? DEFAULT_ATOR_PROXY
      : '',
});
if (config.transport.mode === 'ator') {
  transportProbe.start();
}

// Override host to 0.0.0.0 for container (the default 127.0.0.1 blocks
// external access from Docker networking). Operators can override via env var.
const host =
  process.env['TOWNHOUSE_API_HOST'] ?? config.api.host ?? '0.0.0.0';
const port = Number(process.env['TOWNHOUSE_API_PORT'] ?? config.api.port ?? 28090);

const apiServer = await createApiServer({
  configPath,
  config: {
    ...config,
    api: { ...config.api, host, port },
  },
  orchestrator,
  wallet: walletManager,
  connectorAdmin,
  transportProbe,
});

await apiServer.app.listen({ host, port });
console.log(`[townhouse-api] listening on http://${host}:${port}`);

const shutdown = async (sig: string): Promise<void> => {
  console.log(`\n[townhouse-api] ${sig} — closing...`);
  try {
    transportProbe.stop();
  } catch (_) { /* ignore stop errors on shutdown */ }
  try {
    await apiServer.app.close();
  } catch (_) { /* ignore close errors on shutdown */ }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
