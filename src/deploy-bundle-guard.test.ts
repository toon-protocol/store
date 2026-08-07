import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

// Everything this test reads lives under deploy/, a sibling of src/ at the
// repo root.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepoFile = (relativePath: string): string =>
  readFileSync(`${repoRoot}${relativePath}`, 'utf8');

interface ConnectorRoute {
  prefix: string;
  handler_url: string;
  price: number;
}

interface ConnectorToml {
  settlement: {
    evm: {
      contract_address: string;
      token_address: string;
      decimals: number;
    };
  };
  routes: ConnectorRoute[];
}

const connectorToml = parse(
  readRepoFile('deploy/connector.toml')
) as unknown as ConnectorToml;

interface ComposeService {
  ports?: string[];
  expose?: (string | number)[];
}

interface ComposeFile {
  services: Record<string, ComposeService>;
}

const composeFile = parseYaml(
  readRepoFile('deploy/docker-compose.yml')
) as unknown as ComposeFile;

// A compose `ports:` entry is a string like
// '${EDGE_BIND:-127.0.0.1}:${EDGE_PORT:-3000}:3000' — resolve each
// `${VAR:-default}` to its default so the result reads like the mapping
// Docker actually applies (`HOST_IP:HOST_PORT:CONTAINER_PORT`), rather than
// naively splitting on ':' and tripping over the colon inside `${VAR:-...}`.
function resolveComposeVarDefaults(value: string): string {
  return value.replace(/\$\{[^:}]+:-([^}]*)\}/g, (_match, def: string) => def);
}

// issue#83 / connector#695 / connector#811: the ERC-2771 (meta-tx-aware)
// TokenNetworkRegistry, live on Base Sepolia since the 2026-08-06 cutover —
// what every NEW payment channel resolves against. The pre-cutover registry
// (0xcC9079ad...) still answers on chain for the one channel opened before
// the cutover, but is not what this client-edge-only bundle (no
// [[peer_channels]]) should point a fresh deployment at.
const EXPECTED_CONTRACT_ADDRESS = '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1';

// connector#811: the mock USDC ERC-20 the fleet settles in. Unchanged by the
// ERC-2771 cutover — it is the same token, only the registry/TokenNetwork
// that resolve claims against it moved.
const EXPECTED_TOKEN_ADDRESS = '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce';

// ADR 0010: the fleet-wide settlement asset is 6-decimal USDC everywhere.
const EXPECTED_DECIMALS = 6;

// deploy/connector.toml's own comment: 0.001 USDC in the smallest unit of a
// 6-decimal asset, the flat per-object figure the fleet quotes for a store
// upload — the same price on all three route aliases, by design (see below).
const EXPECTED_ROUTE_PRICE = 1000;

// issue#83 (connector#848): the fleet's pin of record. Must be the earliest
// tag carrying the announce-identity fix (issue #833/#839) — see this
// literal's twin in connector's own devnet_configs_load.rs.
const EXPECTED_CONNECTOR_TAG = 'rust-sha-440eab7';

// Every place in the repo that names the pin: the three that decide what a
// build actually pulls, plus deploy/README.md, which quotes the Dockerfile's
// default in prose and so goes stale the same way.
const CONNECTOR_TAG_SITES: { source: string; pattern: RegExp }[] = [
  { source: 'deploy/Dockerfile', pattern: /^ARG CONNECTOR_TAG=(\S+)$/m },
  {
    source: 'deploy/docker-compose.yml',
    pattern: /CONNECTOR_TAG: \$\{CONNECTOR_TAG:-(\S+)\}/,
  },
  { source: 'deploy/.env.example', pattern: /^CONNECTOR_TAG=(\S+)$/m },
  { source: 'deploy/README.md', pattern: /default `(rust-sha-\S+)`/ },
];

describe('deploy bundle matches the live fleet (issue#83)', () => {
  it('settlement.evm points at the live ERC-2771 registry, token and decimals', () => {
    const { contract_address, token_address, decimals } =
      connectorToml.settlement.evm;

    expect(
      contract_address,
      `deploy/connector.toml [settlement.evm] contract_address: expected the live registry ${EXPECTED_CONTRACT_ADDRESS}, found ${contract_address}`
    ).toBe(EXPECTED_CONTRACT_ADDRESS);

    expect(
      token_address,
      `deploy/connector.toml [settlement.evm] token_address: expected ${EXPECTED_TOKEN_ADDRESS}, found ${token_address}`
    ).toBe(EXPECTED_TOKEN_ADDRESS);

    expect(
      decimals,
      `deploy/connector.toml [settlement.evm] decimals: expected ${EXPECTED_DECIMALS}, found ${decimals}`
    ).toBe(EXPECTED_DECIMALS);
  });

  it('every route prices at the fleet-quoted figure', () => {
    for (const route of connectorToml.routes) {
      expect(
        route.price,
        `deploy/connector.toml [[routes]] prefix "${route.prefix}": expected price ${EXPECTED_ROUTE_PRICE}, found ${route.price}`
      ).toBe(EXPECTED_ROUTE_PRICE);
    }
  });

  it('routes sharing a handler_url share one price (a cheaper door is a free door)', () => {
    const priceByHandler = new Map<string, Set<number>>();
    for (const route of connectorToml.routes) {
      const prices = priceByHandler.get(route.handler_url) ?? new Set<number>();
      prices.add(route.price);
      priceByHandler.set(route.handler_url, prices);
    }

    for (const [handlerUrl, prices] of priceByHandler) {
      expect(
        prices.size,
        `deploy/connector.toml: handler_url "${handlerUrl}" is reachable at ${prices.size} different prices (${[...prices].join(', ')}) — connector's insert_consistent_handler_price refuses this at config load`
      ).toBe(1);
    }
  });

  it('every published port is host-IP-prefixed, never a bare 0.0.0.0 (issue#84)', () => {
    for (const [serviceName, service] of Object.entries(composeFile.services)) {
      for (const portEntry of service.ports ?? []) {
        const resolved = resolveComposeVarDefaults(String(portEntry));
        const parts = resolved.split(':');

        expect(
          parts.length,
          `deploy/docker-compose.yml service "${serviceName}" ports entry "${portEntry}" (resolves to "${resolved}"): expected a host-IP-prefixed mapping (HOST_IP:HOST_PORT:CONTAINER_PORT) — a bare "HOST_PORT:CONTAINER_PORT" publishes on 0.0.0.0, which is internet-reachable regardless of ufw`
        ).toBe(3);

        const hostIp = parts[0];
        expect(
          hostIp === '' || hostIp === '0.0.0.0',
          `deploy/docker-compose.yml service "${serviceName}" ports entry "${portEntry}" (resolves to "${resolved}"): host IP segment "${hostIp}" publishes on all interfaces — bind to a specific host interface (e.g. 127.0.0.1) instead`
        ).toBe(false);
      }
    }
  });

  it("the store's job port (3300) and health port (3400) are internal-only — expose:, never ports: (issue#84)", () => {
    const storeService = composeFile.services['store'];
    expect(storeService, 'deploy/docker-compose.yml: expected a "store" service').toBeDefined();

    const exposedPorts = (storeService?.expose ?? []).map(String);
    for (const privatePort of ['3300', '3400']) {
      expect(
        exposedPorts,
        `deploy/docker-compose.yml service "store": expected port ${privatePort} under expose: (found ${JSON.stringify(exposedPorts)})`
      ).toContain(privatePort);
    }

    for (const [serviceName, service] of Object.entries(composeFile.services)) {
      for (const portEntry of service.ports ?? []) {
        const resolved = resolveComposeVarDefaults(String(portEntry));
        const containerPort = resolved.split(':').pop();
        for (const privatePort of ['3300', '3400']) {
          expect(
            containerPort,
            `deploy/docker-compose.yml service "${serviceName}" ports entry "${portEntry}": container port ${privatePort} (store's job/health port) must never be host-published`
          ).not.toBe(privatePort);
        }
      }
    }
  });

  it('CONNECTOR_TAG agrees across every copy of the pin', () => {
    for (const { source, pattern } of CONNECTOR_TAG_SITES) {
      const found = readRepoFile(source).match(pattern)?.[1];

      expect(
        found,
        `${source}: expected to find a CONNECTOR_TAG pin matching ${pattern}, found none`
      ).toBeDefined();
      expect(
        found,
        `${source}: expected CONNECTOR_TAG ${EXPECTED_CONNECTOR_TAG}, found ${found}`
      ).toBe(EXPECTED_CONNECTOR_TAG);
    }
  });
});
