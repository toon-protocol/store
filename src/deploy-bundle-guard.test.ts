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
  // Both hold YAML scalars, so an unquoted entry parses as a number — hence the
  // String() coercions below.
  ports?: (string | number)[];
  expose?: (string | number)[];
}

interface ComposeFile {
  services: Record<string, ComposeService>;
}

const composeFile = parseYaml(
  readRepoFile('deploy/docker-compose.yml')
) as unknown as ComposeFile;

// A compose `ports:` entry is a string like
// '${EDGE_BIND:-127.0.0.1}:${EDGE_PORT:-3000}:3000' — substitute each `${VAR}`
// / `${VAR:-default}` the way compose would with nothing set in the
// environment, so the result reads like the mapping Docker actually applies
// (`HOST_IP:HOST_PORT:CONTAINER_PORT`), rather than naively splitting on ':'
// and tripping over the colon inside `${VAR:-...}`. A variable with no default
// expands to the empty string, i.e. an all-interfaces bind — which is exactly
// what the assertions below reject.
function substituteComposeVars(value: string): string {
  return value.replace(
    /\$\{[^}:]+(?::-([^}]*))?\}/g,
    (_match, def: string | undefined) => def ?? ''
  );
}

interface PublishedPort {
  serviceName: string;
  entry: string;
  /** `entry` with every `${VAR...}` substituted — see substituteComposeVars. */
  resolved: string;
}

const describePort = ({ serviceName, entry, resolved }: PublishedPort): string =>
  `deploy/docker-compose.yml service "${serviceName}" ports entry "${entry}" (resolves to "${resolved}")`;

// Every host-published port in the bundle, flattened across services: the two
// assertions below both walk this list, one checking its host side and one its
// container side.
const publishedPorts: PublishedPort[] = Object.entries(
  composeFile.services
).flatMap(([serviceName, service]) =>
  (service.ports ?? []).map((rawEntry) => {
    const entry = String(rawEntry);
    return { serviceName, entry, resolved: substituteComposeVars(entry) };
  })
);

// The store's job backend and health ports. Only the connector dials them, over
// the compose network — they belong under `expose:` and never under `ports:`.
const PRIVATE_STORE_PORTS = ['3300', '3400'];

// Host-IP segments that publish on every interface: `0.0.0.0` spelled out, and
// the empty string a default-less `${EDGE_BIND}` expands to.
const ALL_INTERFACE_BINDS = ['', '0.0.0.0'];

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
// upload.
const EXPECTED_ROUTE_PRICE = 1000;

// issue#88: the two-node fleet (docs/two-node-architecture.md, toon-meta repo)
// retired the devnet apex, and with it BOTH aliases that used to sit beside
// this box's own prefix: `g.toon.relay.ario` (the relay-hop spelling — a path
// through the apex that can no longer occur) and `g.toon.store` (owner
// decision 2026-08-05, recorded in the live box's config — connector repo,
// infra/linode-store/connector-rust.toml: it only mirrored the apex's own
// `g.toon.store` forward; one name for one app). The live box terminates
// exactly this one prefix — named as a literal so losing it, or silently
// regaining a retired alias, fails by name instead of passing unnoticed.
// Sorted once here, so the assertion and its message agree.
const EXPECTED_ROUTE_PREFIXES = ['g.toon.ario'].sort();

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

  it("mounts exactly the two-node fleet's route prefixes — no retired alias (issue#88)", () => {
    const foundPrefixes = connectorToml.routes
      .map((route) => route.prefix)
      .sort();

    expect(
      foundPrefixes,
      `deploy/connector.toml [[routes]]: expected exactly ${JSON.stringify(
        EXPECTED_ROUTE_PREFIXES
      )}, found ${JSON.stringify(foundPrefixes)}`
    ).toEqual(EXPECTED_ROUTE_PREFIXES);
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
    for (const port of publishedPorts) {
      const segments = port.resolved.split(':');
      const hostIp = segments[0];

      expect(
        segments.length,
        `${describePort(port)}: expected a host-IP-prefixed mapping (HOST_IP:HOST_PORT:CONTAINER_PORT) — a bare "HOST_PORT:CONTAINER_PORT" publishes on 0.0.0.0, which is internet-reachable regardless of ufw`
      ).toBe(3);

      expect(
        ALL_INTERFACE_BINDS,
        `${describePort(port)}: host IP segment "${hostIp}" publishes on all interfaces — bind to a specific host interface (e.g. 127.0.0.1) instead`
      ).not.toContain(hostIp);
    }
  });

  it("the store's job port (3300) and health port (3400) are internal-only — expose:, never ports: (issue#84)", () => {
    const storeService = composeFile.services['store'];
    expect(
      storeService,
      'deploy/docker-compose.yml: expected a "store" service'
    ).toBeDefined();

    const exposedPorts = (storeService?.expose ?? []).map(String);
    for (const privatePort of PRIVATE_STORE_PORTS) {
      expect(
        exposedPorts,
        `deploy/docker-compose.yml service "store": expected port ${privatePort} under expose: (found ${JSON.stringify(exposedPorts)})`
      ).toContain(privatePort);
    }

    for (const port of publishedPorts) {
      const containerPort = port.resolved.split(':').pop();
      expect(
        PRIVATE_STORE_PORTS,
        `${describePort(port)}: container port ${containerPort} is one of the store's private job/health ports (${PRIVATE_STORE_PORTS.join(', ')}) and must never be host-published`
      ).not.toContain(containerPort);
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
