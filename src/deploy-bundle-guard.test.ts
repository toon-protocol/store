import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

/**
 * Repo-consistency guard for deploy/ — the bundle that IS the store box.
 *
 * These are lint-like invariants rather than unit tests: they assert that the
 * committed deployment still says what the deployment means. They exist
 * because every one of them has been wrong on a live box at least once.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepoFile = (relativePath: string): string =>
  readFileSync(`${repoRoot}${relativePath}`, 'utf8');

// ---------------------------------------------------------------------------
// The connector config is a TEMPLATE. The rendered connector.toml carries the
// operator bearer token, so it is gitignored and does not exist in CI — render
// it here the way render.sh does, with placeholder secrets.
// ---------------------------------------------------------------------------

const CONNECTOR_TEMPLATE = readRepoFile('deploy/connector.toml.template');
const RENDER_SH = readRepoFile('deploy/render.sh');

const RENDER_SUBSTITUTIONS: Record<string, string> = {
  OPERATOR_BEARER_TOKEN: 'f'.repeat(64),
  OPERATOR_WRITE_KEY: 'a'.repeat(64),
};

const renderedConnectorToml = Object.entries(RENDER_SUBSTITUTIONS).reduce(
  (text, [name, value]) => text.replaceAll(`\${${name}}`, value),
  CONNECTOR_TEMPLATE
);

/** A price is either a flat integer or a `{ base, per_kib }` schedule (ADR 0065). */
type ConnectorPrice = number | { base: number; per_kib: number };

/** A route is a prefix plus EXACTLY ONE of handler_url (terminate) or peer_id
 *  (forward), and a price is required on both branches. */
interface ConnectorRoute {
  prefix: string;
  handler_url?: string;
  peer_id?: string;
  price: ConnectorPrice;
}

interface ConnectorPeer {
  id: string;
  endpoint?: string;
  max_packet_amount?: number;
  fee?: number;
}

/** What a route charges for a packet with `payloadLen` bytes of payload. */
const chargeFor = (price: ConnectorPrice, payloadLen: number): number =>
  typeof price === 'number'
    ? price
    : price.base + price.per_kib * Math.ceil(payloadLen / 1024);

interface ConnectorToml {
  client_edge_addr: string;
  state_dir: string;
  settlement: {
    evm: { contract_address: string; token_address: string; decimals: number };
  };
  routes: ConnectorRoute[];
  operator: Record<string, unknown>;
  node?: { addresses: string[]; http_endpoint: string; btp_endpoint: string };
  announce?: unknown;
  peers?: ConnectorPeer[];
  peer_channels?: { peer_id: string; channel_id: string; counterparty_key: string }[];
  pay_channels?: { peer_id: string; channel_id: string; client_edge_url: string }[];
}

const connectorToml = parse(renderedConnectorToml) as unknown as ConnectorToml;

/** The template with comment lines removed — for assertions about config that
 *  must not be confused by prose that merely NAMES a key. */
const connectorTemplateCode = CONNECTOR_TEMPLATE.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

interface ComposeService {
  image?: string;
  labels?: Record<string, string>;
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

// A compose `ports:` entry may be a string like '${EDGE_BIND:-127.0.0.1}:3000:3000'
// — substitute each `${VAR}` / `${VAR:-default}` the way compose would with
// nothing set in the environment, so the result reads like the mapping Docker
// actually applies (`HOST_IP:HOST_PORT:CONTAINER_PORT`), rather than naively
// splitting on ':' and tripping over the colon inside `${VAR:-...}`. A variable
// with no default expands to the empty string, i.e. an all-interfaces bind —
// which is exactly what the assertions below reject.
function substituteComposeVars(value: string): string {
  return value.replace(
    /\$\{[^}:]+(?::-([^}]*))?\}/g,
    (_match, def: string | undefined) => def ?? ''
  );
}

interface PublishedPort {
  serviceName: string;
  entry: string;
  resolved: string;
}

const describePort = ({ serviceName, entry, resolved }: PublishedPort): string =>
  `deploy/docker-compose.yml service "${serviceName}" ports entry "${entry}" (resolves to "${resolved}")`;

const publishedPorts: PublishedPort[] = Object.entries(
  composeFile.services
).flatMap(([serviceName, service]) =>
  (service.ports ?? []).map((rawEntry) => {
    const entry = String(rawEntry);
    return { serviceName, entry, resolved: substituteComposeVars(entry) };
  })
);

// ---------------------------------------------------------------------------
// Constants — each one a thing that has been wrong on a live box.
// ---------------------------------------------------------------------------

// connector#695 / connector#811: the ERC-2771 (meta-tx-aware)
// TokenNetworkRegistry, live on Base Sepolia since the 2026-08-06 cutover.
const EXPECTED_CONTRACT_ADDRESS = '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1';

// connector#811: the mock USDC ERC-20 the fleet settles in.
const EXPECTED_TOKEN_ADDRESS = '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce';

// ADR 0010: the fleet-wide settlement asset is 6-decimal USDC everywhere.
const EXPECTED_DECIMALS = 6;

// The store bills a SCHEDULE, not a flat price: an upload can be any size, and
// a flat figure charges a 50 MB object the same as a 1 KB one. `base` is the
// floor every upload pays (0.001 USDC), `per_kib` the slope — together about
// $10.7/GB, which tracks what permanent Arweave storage costs plus a margin.
const EXPECTED_ROUTE_BASE = 1000;
const EXPECTED_ROUTE_PER_KIB = 10;

// issue#88: the two-node fleet retired the devnet apex, and with it BOTH
// aliases that used to sit beside this box's prefix: `g.toon.relay.ario` (a
// path through the apex that can no longer occur) and `g.toon.store` (owner
// decision 2026-08-05 — one name for one app). The box terminates exactly this
// one prefix; naming it as a literal means losing it, or silently regaining a
// retired alias, fails by name instead of passing unnoticed.
// Both prefixes TERMINATE here. `g.toon.ario` is this node's own name for its
// app; `g.toon.relay.store` is the relay's name for the same app, which the
// relay forwards to us — a forward does not rewrite the destination, so it
// arrives under that name and needs a route of its own.
//
// The outbound leg (`g.toon.store.relay`, forwarded to the relay) is
// deliberately NOT here: it is established at runtime through the operator
// surface. See the template's "The relay leg" section.
const EXPECTED_ROUTE_PREFIXES = ['g.toon.ario', 'g.toon.relay.store'].sort();

const TERMINATED_PREFIX = 'g.toon.ario';
const RELAY_INBOUND_PREFIX = 'g.toon.relay.store';

// The fleet's promotion tag. The store box follows the SAME moving tag the
// rest of the fleet does, rather than an immutable `rust-sha-*` literal — the
// pin of record lives in the promotion (connector's promote-to-fleet.yml), and
// a box pinned to a sha would sit out every fleet promotion silently.
const EXPECTED_CONNECTOR_IMAGE = 'ghcr.io/toon-protocol/connector:rust-release';

// Moved by publish-store-image.yml on every green main, watched by Watchtower.
const EXPECTED_STORE_IMAGE = 'ghcr.io/toon-protocol/store:release';

const WATCHTOWER_LABEL = 'com.centurylinklabs.watchtower.enable';

// The two services that follow a moving tag, and therefore the two — and only
// two — that Watchtower may recreate. nginx holds the resolver that lets every
// other recreate self-heal; certbot holds the renewal timer; Watchtower must
// not recreate itself.
const WATCHED_SERVICES = ['connector', 'store'].sort();

describe('deploy/ bundle is internally consistent', () => {
  it('terminates exactly the route prefixes the fleet expects', () => {
    expect(connectorToml.routes.map((r) => r.prefix).sort()).toEqual(
      EXPECTED_ROUTE_PREFIXES
    );
  });

  it('prices the store route as a schedule over payload length', () => {
    const terminated = connectorToml.routes.find((r) => r.prefix === TERMINATED_PREFIX);
    expect(terminated?.price).toEqual({
      base: EXPECTED_ROUTE_BASE,
      per_kib: EXPECTED_ROUTE_PER_KIB,
    });
  });

  it('serves the relay\'s name for this app at the same price as our own', () => {
    // Both prefixes reach one handler_url, and the connector refuses a config
    // where two such routes disagree on price (ConflictingHandlerPrice) — the
    // cheaper door would otherwise take every packet.
    const inbound = connectorToml.routes.find((r) => r.prefix === RELAY_INBOUND_PREFIX);
    expect(inbound, `${RELAY_INBOUND_PREFIX} must terminate here`).toBeDefined();
    expect(inbound?.handler_url).toBe('http://store:3300/store');
    expect(inbound?.price).toEqual({
      base: EXPECTED_ROUTE_BASE,
      per_kib: EXPECTED_ROUTE_PER_KIB,
    });
  });

  it('charges more for a bigger upload', () => {
    // The whole point of the schedule. Guards against someone flattening it
    // back to an integer without noticing what it was for.
    const price = connectorToml.routes.find((r) => r.prefix === TERMINATED_PREFIX)!.price;
    expect(chargeFor(price, 1024)).toBeLessThan(chargeFor(price, 1024 * 1024));
    // base + per_kib * ceil(bytes/1024), rounded UP to the whole kibibyte
    expect(chargeFor(price, 1)).toBe(EXPECTED_ROUTE_BASE + EXPECTED_ROUTE_PER_KIB);
    expect(chargeFor(price, 0)).toBe(EXPECTED_ROUTE_BASE);
  });

  it('points every terminated route at the backend\'s /store path', () => {
    // The connector POSTs to handler_url LITERALLY. A bare `http://store:3300`
    // reaches the backend and comes back F99 "app declined the delivery with
    // HTTP 404", because the backend serves POST /store.
    const terminated = connectorToml.routes.filter((r) => r.handler_url !== undefined);
    expect(terminated.length).toBeGreaterThan(0);
    for (const route of terminated) {
      expect(
        route.handler_url,
        `route "${route.prefix}" handler_url must end in /store`
      ).toMatch(/^http:\/\/store:3300\/store$/);
    }
  });

  it('gives every route exactly one of handler_url or peer_id', () => {
    for (const route of connectorToml.routes) {
      const branches = [route.handler_url, route.peer_id].filter(
        (b) => b !== undefined
      );
      expect(
        branches.length,
        `route "${route.prefix}" must have exactly one of handler_url / peer_id`
      ).toBe(1);
    }
  });

  it('routes sharing a handler_url agree on price', () => {
    const priceByHandler = new Map<string, string>();
    for (const route of connectorToml.routes) {
      if (route.handler_url === undefined) continue;
      const price = JSON.stringify(route.price);
      const seen = priceByHandler.get(route.handler_url);
      if (seen !== undefined) {
        expect(
          price,
          `routes sharing ${route.handler_url} must agree on price`
        ).toBe(seen);
      }
      priceByHandler.set(route.handler_url, price);
    }
  });

  it('settles against the current registry, token and decimals', () => {
    expect(connectorToml.settlement.evm.contract_address).toBe(
      EXPECTED_CONTRACT_ADDRESS
    );
    expect(connectorToml.settlement.evm.token_address).toBe(EXPECTED_TOKEN_ADDRESS);
    expect(connectorToml.settlement.evm.decimals).toBe(EXPECTED_DECIMALS);
  });

  it('keeps the claim watermark on a mounted volume', () => {
    // A state_dir that dies with the container hands every payer their
    // already-spent claims back as free service.
    expect(connectorToml.state_dir).toBe('/app/state');
    const connector = composeFile.services['connector'];
    expect(
      JSON.stringify(connector),
      'connector must mount a volume at /app/state'
    ).toContain(':/app/state');
  });
});

describe('deploy/ tracks the fleet tags', () => {
  it('runs the connector on the promotion tag', () => {
    expect(composeFile.services['connector']?.image).toBe(EXPECTED_CONNECTOR_IMAGE);
  });

  it('ships no announce sidecar', () => {
    // ADR 0046 removed the one-shot `connector announce` verb the sidecar ran
    // in a loop; `GET /ilp` serves the [node] self-description instead.
    expect(composeFile.services['announce']).toBeUndefined();
  });

  it('runs the store on the tag green main moves', () => {
    expect(composeFile.services['store']?.image).toBe(EXPECTED_STORE_IMAGE);
  });

  it('pins no immutable rust-sha- literal anywhere in the bundle', () => {
    // The bundle follows :rust-release. A stray rust-sha- pin somewhere would
    // mean part of the box sits out fleet promotions with nothing to notice it.
    for (const file of [
      'deploy/docker-compose.yml',
      'deploy/connector.toml.template',
      'deploy/.env.example',
      'deploy/README.md',
    ]) {
      expect(readRepoFile(file), `${file} must not pin a rust-sha- tag`).not.toMatch(
        /rust-sha-[0-9a-f]{7}/
      );
    }
  });

  it('labels exactly the services that follow a moving tag', () => {
    const labelled = Object.entries(composeFile.services)
      .filter(([, service]) => service.labels?.[WATCHTOWER_LABEL] === 'true')
      .map(([name]) => name)
      .sort();
    expect(labelled).toEqual(WATCHED_SERVICES);
  });

  it('never lets Watchtower recreate the TLS edge or itself', () => {
    for (const name of ['nginx', 'certbot', 'watchtower']) {
      expect(
        composeFile.services[name]?.labels?.[WATCHTOWER_LABEL],
        `service "${name}" must NOT carry the Watchtower enable label`
      ).toBeUndefined();
    }
  });
});

describe('deploy/ config matches the promoted connector', () => {
  // The connector parser is deny_unknown_fields and startup is fail-closed, so
  // a key a connector has removed is a refuse-to-start, not a degraded run.
  // Verified by running this config against the promoted build. Asserted
  // against the parsed document and comment-stripped source, so prose that
  // merely names a retired key does not trip them.

  it('uses [node], not the retired [announce]', () => {
    expect(connectorToml.announce).toBeUndefined();
    expect(connectorTemplateCode).not.toMatch(/^\s*\[announce\]/m);
    expect(connectorToml.node?.addresses).toEqual(['g.toon.ario']);
  });

  it('declares no peering shared secret', () => {
    // ADR 0060 deleted `[[peers]] credential` by name — a peering is proven by
    // a verified claim on a [[peer_channels]] row, not by a string both
    // operators wrote into their own config files.
    expect(connectorTemplateCode).not.toMatch(/credential/);
  });

  // NOTE: inline operator keys are not deprecated — a newer connector accepts
  // BOTH these and the *_file variants. This asserts what this bundle uses so
  // the template and the rendered file cannot silently disagree, not that the
  // *_file form is wrong.
  it('uses inline operator credentials', () => {
    expect(Object.keys(connectorToml.operator).sort()).toEqual([
      'bearer_token',
      'write_keys',
    ]);
    expect(connectorTemplateCode).not.toMatch(/bearer_token_file|write_keys_file/);
  });
});

describe('deploy/ render.sh substitutes exactly what the templates need', () => {
  const placeholdersIn = (text: string): string[] =>
    [...text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]!).sort();

  it('covers every placeholder in the connector template', () => {
    const needed = new Set(placeholdersIn(connectorTemplateCode));
    for (const name of needed) {
      expect(
        RENDER_SH,
        `render.sh must pass \${${name}} to envsubst for connector.toml.template`
      ).toContain(`\${${name}}`);
      expect(
        Object.keys(RENDER_SUBSTITUTIONS),
        `this test must render \${${name}} too`
      ).toContain(name);
    }
  });

  it('covers every placeholder in the nginx template', () => {
    const nginxTemplate = readRepoFile('deploy/nginx/node.conf.template');
    for (const name of new Set(placeholdersIn(nginxTemplate))) {
      expect(
        RENDER_SH,
        `render.sh must pass \${${name}} to envsubst for node.conf.template`
      ).toContain(`\${${name}}`);
    }
  });

  it('renders the connector template into valid TOML with no leftovers', () => {
    expect(renderedConnectorToml).not.toMatch(/\$\{/);
    expect(() => parse(renderedConnectorToml)).not.toThrow();
  });

  it('keeps the rendered connector.toml out of git', () => {
    // It carries the operator bearer token inline on this connector tag.
    expect(readRepoFile('deploy/.gitignore')).toMatch(/^connector\.toml$/m);
  });
});

describe('deploy/ leaves the relay peering to the operator surface', () => {
  // ADR 0058 establishes a peering from the counterparty's URL at runtime:
  // POST /peers reads its self-description, derives the payment channel and
  // opens it on chain if absent, then POST /routes/peers adds the forwarded
  // route. Both rows live in the durable runtime table, not here.
  //
  // This is not a style choice — it is an ownership one. A runtime write is
  // refused outright when the config file owns the key (CF-32), and a durable
  // runtime row whose key config later claims is DELETED rather than shadowed
  // (CF-33). Ownership is permanent, so writing a peer row here would take the
  // peering away from the surface that manages it, for good.

  it('declares no peer, and no channel book, in the config file', () => {
    expect(connectorToml.peers, 'a [[peers]] row here would claim the key from the operator surface').toBeUndefined();
    expect(connectorToml.peer_channels).toBeUndefined();
    expect(connectorToml.pay_channels).toBeUndefined();
  });

  it('declares no forwarded route in the config file', () => {
    for (const route of connectorToml.routes) {
      expect(
        route.peer_id,
        `route "${route.prefix}" forwards, and a forwarded route belongs to the runtime table`
      ).toBeUndefined();
    }
  });

  it('still accepts peer carriage, so a peering can be established at all', () => {
    // A peering needs somewhere to arrive. The relay dials us.
    expect(connectorTemplateCode).toMatch(/^\s*peer_expose\s*=\s*"btp"/m);
  });
});

describe('deploy/ publishes nothing it should not', () => {
  it('publishes only the TLS edge on public interfaces', () => {
    for (const port of publishedPorts) {
      const segments = port.resolved.split(':');
      const isPublic =
        segments.length < 3 || segments[0] === '' || segments[0] === '0.0.0.0';
      if (isPublic) {
        expect(
          port.serviceName,
          `${describePort(port)} publishes on all interfaces; only nginx may`
        ).toBe('nginx');
        expect(
          segments[segments.length - 2],
          `${describePort(port)} — nginx may publish only 80 and 443`
        ).toMatch(/^(80|443)$/);
      }
    }
  });

  it('binds the paid connector edge to the loopback only', () => {
    // Docker publishes ports by writing iptables rules that BYPASS ufw, so a
    // 0.0.0.0 bind here would put the paid edge on the public internet behind
    // a firewall that says otherwise. nginx is the only intended front door.
    const connectorPorts = publishedPorts.filter((p) => p.serviceName === 'connector');
    expect(connectorPorts.length).toBeGreaterThan(0);
    for (const port of connectorPorts) {
      expect(port.resolved, describePort(port)).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
    }
  });

  it('keeps the store backend and health ports off the host entirely', () => {
    const store = composeFile.services['store'];
    expect(store?.ports, 'store must not publish any host port').toBeUndefined();
    expect((store?.expose ?? []).map(String).sort()).toEqual(['3300', '3400']);
  });
});
