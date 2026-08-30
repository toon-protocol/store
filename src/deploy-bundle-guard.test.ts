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
// The connector config is a TEMPLATE. The rendered connector.toml is gitignored
// and does not exist in CI, so render it here the way render.sh does. It holds
// no credential any more — the operator surface's two values live in their own
// files — but the substitution table stays, so a placeholder reintroduced to
// the template has to be rendered here too rather than parsed as literal text.
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
    solana: { program_id: string; token_address: string; decimals: number };
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
  volumes?: string[];
  healthcheck?: { test?: string[]; interval?: string; retries?: number };
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
// TokenNetworkRegistry -- since 2026-08-28 the ADR 0059 cutover's (connector
// docs/evm-deployment.md), whose TokenNetwork derives channel ids.
const EXPECTED_CONTRACT_ADDRESS = '0x0c41D9D424d6B075A3cEa1068a694f7847a8CCa5';

// connector#811: the mock USDC ERC-20 the fleet settles in.
const EXPECTED_TOKEN_ADDRESS = '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce';

// ADR 0010: the fleet-wide settlement asset is 6-decimal USDC everywhere.
const EXPECTED_DECIMALS = 6;

// The Solana half of the same settlement statement. connector#1212: the mock
// USDC this node named until 2026-08-27 is still on chain and still holds its
// supply, but its MINT AUTHORITY was a key held outside every repository and
// it is lost -- so nobody can issue that token and nobody can refill a
// treasury holding it. The devnet faucet's Solana leg served 503s for weeks
// on that account. This mint's authority is the faucet box's own treasury, so
// the faucet mints per drip and no irreplaceable key is left in the design.
//
// Squarely "a thing that has been wrong on a live box", and it went unnoticed
// because only the EVM leg above was ever asserted here.
const EXPECTED_SOLANA_PROGRAM_ID = '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip';
const EXPECTED_SOLANA_TOKEN_ADDRESS =
  '34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU';

// The store bills a SCHEDULE, not a flat price: an upload can be any size, and
// a flat figure charges a 50 MB object the same as a 1 KB one. `base` is the
// floor every upload pays (0.001 USDC), `per_kib` the slope — together about
// $10.7/GB, which tracks what permanent Arweave storage costs plus a margin.
const EXPECTED_ROUTE_BASE = 1000;
const EXPECTED_ROUTE_PER_KIB = 10;

// One name, held to as a literal, because every alias this box ever carried
// was eventually removed and each removal had to be caught by name rather
// than noticed later on a live box. issue#88 retired the devnet apex and the
// `g.toon.relay.ario` hop through it (#94), which also renamed this box's own
// prefix `g.toon.ario` -> `g.toon.store`.
// TERMINATED and ADVERTISED are two different lists, and this box's whole
// naming decision (owner, 2026-08-28) is the gap between them.
//
// It TERMINATES two names. Its own, and `g.toon.relay.store` -- the relay's
// name for this service, beneath the RELAY's prefix -- because the relay
// routes to this box under that name and a forward copies the destination
// through verbatim, so a packet arrives wearing it and needs a row or it is
// refused at the door.
//
// It ADVERTISES one: its own. `g.toon.relay.store` belongs to the relay's
// prefix and is the relay's to hand out; this box answers to it without
// claiming it in `GET /ilp`.
const EXPECTED_ROUTE_PREFIXES = ['g.toon.store', 'g.toon.relay.store'].sort();
const EXPECTED_ADVERTISED_ADDRESSES = ['g.toon.store'];
const RELAYS_NAME_FOR_US = 'g.toon.relay.store';

const TERMINATED_PREFIX = 'g.toon.store';

// One immutable connector build, pinned here and in docker-compose.yml
// together. This box used to follow the fleet's `:rust-release` pointer on the
// theory that the pin of record lived in the promotion; nothing moves that
// pointer any more (connector ADR 0068 — a node repository pins the connector
// it runs, in one place, guarded there), so following it meant standing still
// at connector 8708caf, before connector#1230 — and a peering established by
// POST /peers could accept but never pay. The relay leg this box opened
// (`g.toon.store.relay`) forwarded for free on that build. Bumping this
// literal and the compose tag in one reviewed commit is how the connector
// moves now.
const EXPECTED_CONNECTOR_IMAGE = 'ghcr.io/toon-protocol/connector:rust-2026.08.28.1';

// Moved by publish-store-image.yml on every green main, watched by Watchtower.
const EXPECTED_STORE_IMAGE = 'ghcr.io/toon-protocol/store:release';

const WATCHTOWER_LABEL = 'com.centurylinklabs.watchtower.enable';

// The two app services, and therefore the two — and only two — that
// Watchtower may recreate: the store follows a moving tag, and the connector
// keeps the label so a bumped pin is picked up on the next `up -d`. nginx
// holds the resolver that lets every other recreate self-heal; certbot holds
// the renewal timer; Watchtower must not recreate itself.
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


  it("terminates the relay's name for us at the same handler, on the same schedule", () => {
    // One handler at two prices is refused by the connector outright, and a
    // cheaper second door would take every packet anyway.
    const ours = connectorToml.routes.find((r) => r.prefix === TERMINATED_PREFIX);
    const theirs = connectorToml.routes.find((r) => r.prefix === RELAYS_NAME_FOR_US);
    expect(theirs?.handler_url).toBe(ours?.handler_url);
    expect(theirs?.price).toEqual(ours?.price);
  });

  it("answers to the relay's name for us without advertising it", () => {
    // The gap between the two lists, asserted directly: routed, not claimed.
    // Re-adding it to `[node]` would have this box telling every client that
    // discovers it that it owns a name under the relay's prefix.
    expect(connectorToml.routes.map((r) => r.prefix)).toContain(RELAYS_NAME_FOR_US);
    expect(connectorToml.node?.addresses).not.toContain(RELAYS_NAME_FOR_US);
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

  it('settles against the current Solana program, mint and decimals', () => {
    // A claim resolves against ONE deployment (connector ADR 0053 binds the
    // program into the signed message), so naming a different program or mint
    // than the fleet does is a node that cannot settle what buyers opened.
    expect(connectorToml.settlement.solana.program_id).toBe(
      EXPECTED_SOLANA_PROGRAM_ID
    );
    expect(connectorToml.settlement.solana.token_address).toBe(
      EXPECTED_SOLANA_TOKEN_ADDRESS
    );
    expect(connectorToml.settlement.solana.decimals).toBe(EXPECTED_DECIMALS);
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

describe('deploy/ pins the connector and follows the store tag', () => {
  it('pins one immutable build -- a rust-sha- build or a rust-<release handle> -- never a moving tag', () => {
    // Nothing moves `:rust-release` any more (connector ADR 0068); a bundle
    // following it stands still. The literal here and in docker-compose.yml
    // are the two places a bump has to land, together, and
    // .github/workflows/adopt-connector-release.yml is what lands both when
    // the connector cuts a release.
    //
    // TWO shapes are accepted, because immutability is the property that
    // actually matters here, not the spelling: `rust-sha-<commit>`, stamped
    // on every connector build, and `rust-<YYYY.MM.DD.N>`, stamped on a cut
    // release. Nothing ever repoints either. A moving tag -- `:rust-release`,
    // `:rust-main`, `:latest` -- is what this rejects, because it would make
    // the pin a pointer someone else controls and put an unreviewed build on
    // this box.
    const image = composeFile.services['connector']?.image;
    expect(image).toBe(EXPECTED_CONNECTOR_IMAGE);
    expect(image).toMatch(/:(rust-sha-[0-9a-f]{7,40}|rust-\d{4}\.\d{2}\.\d{2}\.\d+)$/);
    expect(readRepoFile('deploy/docker-compose.yml')).not.toContain('rust-release');
  });

  it('ships no announce sidecar', () => {
    // ADR 0046 removed the one-shot `connector announce` verb the sidecar ran
    // in a loop; `GET /ilp` serves the [node] self-description instead.
    expect(composeFile.services['announce']).toBeUndefined();
  });

  it('runs the store on the tag green main moves', () => {
    expect(composeFile.services['store']?.image).toBe(EXPECTED_STORE_IMAGE);
  });

  it('carries the pin literal in docker-compose.yml and nowhere else in the bundle', () => {
    // One pin, one place. A second rust-sha- literal in the template, the env
    // example or the README is a stale copy waiting to be read as the truth
    // after the next bump; the docs say `rust-sha-` generically instead.
    for (const file of [
      'deploy/connector.toml.template',
      'deploy/.env.example',
      'deploy/README.md',
    ]) {
      expect(readRepoFile(file), `${file} must not pin a rust-sha- tag`).not.toMatch(
        /rust-sha-[0-9a-f]{7}/
      );
    }
  });

  it('says out loud how the pin is bumped', () => {
    expect(CONNECTOR_TEMPLATE).toMatch(/targets an exact, immutable build/);
    expect(readRepoFile('deploy/README.md')).toMatch(/^## Bumping the connector pin/m);
  });

  it('labels exactly the two app services for Watchtower', () => {
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

describe('deploy/ config matches the pinned connector', () => {
  // The connector parser is deny_unknown_fields and startup is fail-closed, so
  // a key a connector has removed is a refuse-to-start, not a degraded run.
  // Verified by booting the pinned image on this config. Asserted
  // against the parsed document and comment-stripped source, so prose that
  // merely names a retired key does not trip them.

  it('uses [node], not the retired [announce]', () => {
    expect(connectorToml.announce).toBeUndefined();
    expect(connectorTemplateCode).not.toMatch(/^\s*\[announce\]/m);
    // Advertise this box's OWN name and nothing else. Not every terminated
    // prefix: `g.toon.relay.store` is terminated and deliberately unsaid.
    //
    // A name advertised but not terminated would be the broken direction --
    // this box telling clients to pay a name it cannot honour -- so the
    // advertised list must stay a subset of the routed one.
    //
    // NB: `POST /peers` on the relay reads this self-description for the
    // SETTLEMENT addresses, to derive the payment channel — not for routing
    // prefixes. The relay's `POST /routes/peers` takes its prefix as a
    // literal in the operator's write, so this list never fed that route.
    // That is why dropping the relay's name from here does not disturb the
    // peering or the route the relay holds.
    expect(connectorToml.node?.addresses.slice().sort()).toEqual(
      EXPECTED_ADVERTISED_ADDRESSES.slice().sort()
    );
    for (const advertised of connectorToml.node?.addresses ?? []) {
      expect(EXPECTED_ROUTE_PREFIXES).toContain(advertised);
    }
  });

  it('declares no peering shared secret', () => {
    // ADR 0060 deleted `[[peers]] credential` by name — a peering is proven by
    // a verified claim on a [[peer_channels]] row, not by a string both
    // operators wrote into their own config files.
    expect(connectorTemplateCode).not.toMatch(/credential/);
  });

  // The operator surface's two credentials are FILE-VALUED, the way every
  // other credential in this config is (the connector accepts both spellings).
  // Inline values made the rendered connector.toml itself a secret; paths mean
  // the only secret on the box is the file, which is the same shape the relay
  // and gas-station bundles run.
  it('names the operator credentials by path, never inline', () => {
    expect(Object.keys(connectorToml.operator).sort()).toEqual([
      'bearer_token_file',
      'write_keys_file',
    ]);
    expect(connectorToml.operator['bearer_token_file']).toBe(
      '/app/data/operator-bearer.token'
    );
    expect(connectorToml.operator['write_keys_file']).toBe(
      '/app/data/operator-write.keys'
    );
    // The inline spelling must not come back: it would put a live credential
    // into the rendered file again.
    expect(connectorTemplateCode).not.toMatch(/^\s*bearer_token\s*=/m);
    expect(connectorTemplateCode).not.toMatch(/^\s*write_keys\s*=/m);
  });

  it('mounts both operator credential files read-only where the config names them', () => {
    // A path the config names but the compose file does not mount is a
    // refuse-to-start: the connector reads the section at boot, fail-closed.
    const volumes = composeFile.services['connector']?.volumes ?? [];
    for (const file of ['operator-bearer.token', 'operator-write.keys']) {
      expect(
        volumes,
        `connector must mount ./${file} at /app/data/${file} read-only`
      ).toContain(`./${file}:/app/data/${file}:ro`);
    }
  });

  it('proves the connector is SERVING, not merely up', () => {
    // `docker ps` showing "Up" says the process exists. GET /ilp/identity is
    // unauthenticated and answers 200 only once the listener is bound and the
    // signer key file has been read.
    const healthcheck = composeFile.services['connector']?.healthcheck;
    expect(healthcheck, 'the connector service needs a healthcheck').toBeDefined();
    const test = (healthcheck?.test ?? []).join(' ');
    expect(test).toContain('/ilp/identity');
    // 127.0.0.1, never localhost: the listener is IPv4-only, and "localhost"
    // in a container can resolve to ::1, where nothing answers.
    expect(test).toContain('http://127.0.0.1:4000/ilp/identity');
    expect(test, 'localhost can resolve to ::1 in a container').not.toContain(
      'localhost'
    );
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

  it('keeps every rendered file, and both operator credentials, out of git', () => {
    // connector.toml is only paths now, but the two files render.sh writes
    // beside it are the real credentials — and neither matches the `*.key`
    // rule already there.
    const ignored = readRepoFile('deploy/.gitignore');
    expect(ignored).toMatch(/^connector\.toml$/m);
    expect(ignored).toMatch(/^operator-bearer\.token$/m);
    expect(ignored).toMatch(/^operator-write\.keys$/m);
  });

  it('writes both operator credential files from the same .env variables', () => {
    // The variable names did not change — operators already have them set.
    expect(RENDER_SH).toMatch(/\$\{OPERATOR_BEARER_TOKEN\}.*>\s*operator-bearer\.token/s);
    expect(RENDER_SH).toContain('${OPERATOR_WRITE_KEY}');
    expect(RENDER_SH).toContain('> operator-write.keys');
  });

  it('hands both operator files to the container uid, 0600', () => {
    // A root-owned 0600 file is unreadable to uid 10001 — "Permission denied",
    // then a restart loop.
    expect(RENDER_SH).toMatch(/chmod 600 .*operator-bearer\.token operator-write\.keys/);
    expect(RENDER_SH).toMatch(/chown "\$\{CONNECTOR_UID:-10001\}/);
    expect(RENDER_SH).toMatch(/not running as root/);
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

describe('deploy/ auto-apply.sh activates what it renders', () => {
  // store#124: the rendered connector.toml is bind-mounted, and `up -d`
  // recreates a container on a changed image or definition, never on changed
  // bytes behind a bind mount, so a green apply left a rendered addresses
  // change on disk but not live for hours. These assert the CONTRACT of the
  // fix rather than its exact spelling: a detected config change earns the
  // connector (and only the connector) a restart, in the right order, and the
  // script then proves the running connector serves what was rendered.

  const AUTO_APPLY = readRepoFile('deploy/auto-apply.sh');
  const lines = AUTO_APPLY.split('\n');
  const isCode = (line: string): boolean => !/^\s*#/.test(line);
  const firstCodeLine = (re: RegExp): number =>
    lines.findIndex((line) => isCode(line) && re.test(line));

  it('restarts the connector service, and never the whole project', () => {
    // `restarting`/`restarted` in log text deliberately do not match \brestart\b.
    const restarts = lines.filter((line) => isCode(line) && /\brestart\b/.test(line));
    expect(
      restarts.length,
      'a rendered config change must be activated by a restart'
    ).toBeGreaterThan(0);
    for (const line of restarts) {
      // A bare `restart` bounces every service, nginx included, whose whole
      // job is to outlive the others.
      expect(
        line,
        'every restart must name exactly the connector service'
      ).toMatch(/\brestart\s+connector\s*$/);
    }
  });

  it('keys the restart on the fingerprints AND the served state, inside a conditional', () => {
    // The mechanism: fingerprint the connector's rendered inputs before and
    // after render.sh runs, read what the RUNNING connector serves, and
    // restart when either disagrees. The served-state trigger is the one that
    // heals a box already sitting on a stale config (store#124 itself): a
    // byte-comparison of this run's disk can never see that state.
    const checksumAt = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => isCode(line) && /\b(?:sha\d+sum|md5sum|cksum)\b/.test(line))
      .map(({ index }) => index);
    expect(
      checksumAt.length,
      'the rendered inputs must be fingerprinted (before AND after render.sh)'
    ).toBeGreaterThanOrEqual(1);
    const renderAt = firstCodeLine(/\.\/render\.sh$/);
    expect(renderAt).toBeGreaterThanOrEqual(0);
    const sumBeforeAt = firstCodeLine(/^SUM_BEFORE=/);
    const sumAfterAt = firstCodeLine(/^SUM_AFTER=/);
    expect(sumBeforeAt, 'a fingerprint must be taken before render.sh').toBeLessThan(renderAt);
    expect(sumAfterAt, 'a fingerprint must be taken after render.sh').toBeGreaterThan(renderAt);

    const restartAt = firstCodeLine(/\brestart\s+connector\b/);
    expect(restartAt).toBeGreaterThanOrEqual(0);

    // The restart must sit INSIDE an if-block (unbalanced `if` depth at its
    // line), not merely somewhere after one -- a mutation that hoists it out
    // of the conditional must fail here.
    const depthAt = (index: number): number =>
      lines
        .slice(0, index)
        .filter(isCode)
        .reduce(
          (depth, line) =>
            depth + (/^\s*if\b/.test(line) ? 1 : 0) - (/^\s*fi\b/.test(line) ? 1 : 0),
          0
        );
    expect(depthAt(restartAt), 'the restart must be inside an if-block').toBeGreaterThan(0);

    // Both triggers must exist as code, before the restart: the fingerprint
    // inequality and the served-vs-rendered inequality.
    const fingerprintTrigger = firstCodeLine(/"\$SUM_AFTER"\s*!=\s*"\$SUM_BEFORE"/);
    const servedTrigger = firstCodeLine(/"\$GOT"\s*!=\s*"\$WANT"/);
    expect(fingerprintTrigger, 'the fingerprint inequality must gate activation').toBeGreaterThanOrEqual(0);
    expect(fingerprintTrigger).toBeLessThan(restartAt);
    expect(servedTrigger, 'the served-state inequality must gate activation').toBeGreaterThanOrEqual(0);
    expect(servedTrigger).toBeLessThan(restartAt);

    // And the restart's own guard must consume what those triggers set.
    const guard = lines
      .slice(0, restartAt)
      .reverse()
      .find((line) => isCode(line) && /^\s*if\b/.test(line));
    expect(guard, 'the restart must be conditional').toBeDefined();
    expect(guard, 'the condition must consume the two triggers').toMatch(/NEEDS_RESTART/);
    const triggerAssignments = lines.filter(
      (line) => isCode(line) && /NEEDS_RESTART=1/.test(line)
    );
    expect(
      triggerAssignments.length,
      'both triggers must arm the restart'
    ).toBeGreaterThanOrEqual(2);
  });

  it('renders, reads the served state, restarts, waits healthy again, then re-verifies', () => {
    // Story 8's ordering, asserted on the lines that DO the work rather than
    // on any curl in a helper definition: after the restart there must be a
    // fresh health wait and a fresh served-state read, and the final
    // comparison must judge that fresh read.
    const renderAt = firstCodeLine(/\.\/render\.sh$/);
    const restartAt = firstCodeLine(/\brestart\s+connector\b/);
    expect(renderAt).toBeGreaterThanOrEqual(0);
    expect(restartAt, 'the restart must come after render.sh').toBeGreaterThan(renderAt);

    // An invocation, not the function definition line.
    const healthWaits = lines
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line }) =>
          isCode(line) && /wait_connector_healthy\b/.test(line) && !/\(\)/.test(line)
      )
      .map(({ index }) => index);
    expect(
      healthWaits.some((index) => index > restartAt),
      'a health wait must follow the restart -- a restart after the last wait is story 8 broken'
    ).toBe(true);

    const servedReads = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => isCode(line) && /GOT=\$\(served_ilp_addresses\)/.test(line))
      .map(({ index }) => index);
    expect(
      servedReads.length,
      'the served state must be read before the decision and again after the restart'
    ).toBeGreaterThanOrEqual(2);
    const lastServedRead = Math.max(...servedReads);
    expect(lastServedRead, 'the post-restart read must follow the restart').toBeGreaterThan(
      restartAt
    );
    const lastCompareAt = lines.reduce(
      (last, line, index) =>
        isCode(line) && /"\$GOT"\s*!=\s*"\$WANT"/.test(line) ? index : last,
      -1
    );
    expect(
      lastCompareAt,
      'the final verdict must judge the post-restart read'
    ).toBeGreaterThan(lastServedRead);
    expect(
      lines.slice(lastCompareAt).join('\n'),
      'a mismatch must exit non-zero'
    ).toMatch(/\bexit\s+1\b/);
  });

  it('verifies against ilpAddresses specifically, and refuses vacuous or unreachable answers', () => {
    // The body also lists routes[].prefix, and this box deliberately
    // terminates a name it does not advertise -- comparing anything wider
    // than ilpAddresses fails every healthy apply. The assertion pins the
    // extraction to the line that PRODUCES the served list, not to the word
    // appearing anywhere in the file.
    const producerAt = firstCodeLine(/grep -o '"ilpAddresses":/);
    expect(
      producerAt,
      'the served-address extraction must select the ilpAddresses field'
    ).toBeGreaterThanOrEqual(0);
    const helperStart = firstCodeLine(/^served_ilp_addresses\(\)/);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(
      producerAt,
      'the extraction must live in the helper every GOT read goes through'
    ).toBeGreaterThan(helperStart);

    // An empty rendered address list would let the comparison pass vacuously.
    const emptyWantGuard = firstCodeLine(/-z\s+"\$WANT"/);
    expect(emptyWantGuard, 'an empty WANT must be refused, not compared').toBeGreaterThanOrEqual(0);

    // A curl failure must surface as "unreachable", never as a mismatch: the
    // helper propagates curl's failure, and both call sites handle it.
    expect(
      AUTO_APPLY,
      'curl must not be masked with || true'
    ).not.toMatch(/curl[^\n]*\|\|\s*true/);
    const unreachableHandlers = lines.filter(
      (line) => isCode(line) && /unreachable/.test(line)
    );
    expect(
      unreachableHandlers.length,
      'both served-state reads must report an unreachable /ilp by name'
    ).toBeGreaterThanOrEqual(2);
  });

  it('fingerprints every file render.sh writes that the connector bind-mounts', () => {
    // A rotated OPERATOR_WRITE_KEY re-renders only operator-write.keys; if the
    // fingerprint watched connector.toml alone, the revoked key would stay
    // authorised behind a green apply -- store#124's bug class, for a
    // security-relevant file. The fingerprinted set must cover every ./ bind
    // into the connector service.
    const helperStart = firstCodeLine(/^fingerprint_connector_inputs\(\)/);
    expect(helperStart, 'the fingerprint helper must exist').toBeGreaterThanOrEqual(0);
    const helperEnd = lines.findIndex((line, index) => index > helperStart && /^\}/.test(line));
    const helperBody = lines.slice(helperStart, helperEnd + 1).join('\n');

    const connectorBinds = (composeFile.services['connector']?.volumes ?? [])
      .map(String)
      .filter((volume) => volume.startsWith('./'))
      .map((volume) => volume.slice(2).split(':')[0] ?? '');
    expect(connectorBinds.length).toBeGreaterThan(0);
    for (const bind of connectorBinds) {
      expect(
        helperBody,
        `the fingerprint must cover the bind-mounted ${bind}`
      ).toContain(bind);
    }
  });
});
