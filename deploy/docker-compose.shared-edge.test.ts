/**
 * deploy/docker-compose.shared-edge.yml -- the overlay that lets this box
 * run behind the devnet host's shared edge instead of terminating its own
 * TLS (infra#24, infra ADR 0001, store#137).
 *
 * The oracle is the REAL `docker compose config`, not a hand-rolled YAML
 * merge: compose's own override semantics (profiles excluding a service
 * outright, `networks:` replacing rather than extending, `${VAR}` scalars
 * normalising to bytes) are exactly what a bundle run on a real box goes
 * through, and are exactly what a hand-rolled merge would get subtly wrong.
 * `docker compose config` needs no daemon and no bind-mount source files to
 * exist -- it only parses and merges YAML -- so this runs the same in CI as
 * on a laptop with no `.env` ever rendered.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const deployDir = fileURLToPath(new URL('.', import.meta.url));

// The connector's env block requires this at interpolation time; nothing
// else in either compose file needs a real secret to be parsed.
const ENV = {
  ...process.env,
  STORE_NOSTR_SECRET_KEY: '1'.repeat(64),
};

interface ComposePort {
  host_ip?: string;
  target: number;
  published?: string;
}

interface ComposeService {
  image?: string;
  mem_limit?: string;
  profiles?: string[];
  ports?: ComposePort[];
  networks?: Record<string, { aliases?: string[] } | null>;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
  networks?: Record<string, { external?: boolean; name?: string }>;
}

/** Runs the real `docker compose config` over the given files (relative to
 *  deploy/) and returns the merged, fully-interpolated config. */
function composeConfig(files: string[]): ComposeConfig {
  const args = files.flatMap((f) => ['-f', f]).concat(['config', '--format', 'json']);
  const out = execFileSync('docker', ['compose', ...args], {
    cwd: deployDir,
    env: ENV,
    encoding: 'utf8',
  });
  return JSON.parse(out) as ComposeConfig;
}

const BASE = 'docker-compose.yml';
const OVERLAY = 'docker-compose.shared-edge.yml';

// The overlay file's OWN services -- read directly, not through `config` --
// because a profile-disabled service is dropped entirely from a merged
// config with no profile active, which is the right behaviour for the "no
// port 80/443" assertion but the wrong source for "every service declares a
// mem_limit": that must hold for nginx/certbot/watchtower too, in case the
// `disabled` profile is ever activated by hand.
const overlayYaml = parseYaml(
  readFileSync(`${deployDir}${OVERLAY}`, 'utf8')
) as { services: Record<string, ComposeService> };

describe('deploy/docker-compose.shared-edge.yml', () => {
  it('disables nginx, certbot and watchtower entirely with no active profile', () => {
    const merged = composeConfig([BASE, OVERLAY]);
    for (const name of ['nginx', 'certbot', 'watchtower']) {
      expect(
        merged.services[name],
        `"${name}" must be dropped from the default (no-profile) config`
      ).toBeUndefined();
    }
    expect(Object.keys(merged.services).sort()).toEqual(['connector', 'store']);
  });

  it('never binds host port 80 or 443 when the overlay is on', () => {
    // The connector keeps its 127.0.0.1:4000 loopback publish from
    // docker-compose.yml -- bootstrap.sh and auto-apply.sh still read it
    // there, and it was never a public bind. What must disappear is 80 and
    // 443: with nginx disabled, nothing in this bundle may claim them, since
    // the shared edge owns both on the host.
    const merged = composeConfig([BASE, OVERLAY]);
    for (const [name, service] of Object.entries(merged.services)) {
      for (const port of service.ports ?? []) {
        expect(
          [80, 443],
          `service "${name}" must not publish host port ${port.target}`
        ).not.toContain(port.target);
      }
    }
  });

  it('joins the connector to the external `edge-store` network as `store-proxy`', () => {
    const merged = composeConfig([BASE, OVERLAY]);
    const networks = merged.services['connector']?.networks ?? {};
    expect(Object.keys(networks).sort()).toEqual(['default', 'edge-store']);
    expect(networks['edge-store']?.aliases).toEqual(['store-proxy']);
  });

  it('joins the store to the external `edge-store` network as `store-dvm`', () => {
    const merged = composeConfig([BASE, OVERLAY]);
    const networks = merged.services['store']?.networks ?? {};
    expect(Object.keys(networks).sort()).toEqual(['default', 'edge-store']);
    expect(networks['edge-store']?.aliases).toEqual(['store-dvm']);
  });

  it('declares `edge-store` as an external network it does not own', () => {
    const merged = composeConfig([BASE, OVERLAY]);
    expect(merged.networks?.['edge-store']?.external).toBe(true);
  });

  it('never joins the old flat `edge` network (shared contract v2: one network per node)', () => {
    // v1 of the contract had every node on one flat `edge` network, which let
    // this box's connector reach every OTHER node's connector /admin and the
    // gateway's handover port. v2 replaces it with a network per node
    // (`edge-store` here); the bare name `edge` must not appear anywhere in
    // the overlay any more -- checked on the source text, not just the
    // merged config, since a name only used in a comment would not show up
    // in `docker compose config` at all.
    const merged = composeConfig([BASE, OVERLAY]);
    expect(Object.keys(merged.networks ?? {})).not.toContain('edge');
    const overlayText = readFileSync(`${deployDir}${OVERLAY}`, 'utf8');
    expect(overlayText, 'no bare "edge:" network key (YAML)').not.toMatch(/^\s*edge:\s*$/m);
    expect(overlayText, 'no backtick-quoted `edge` network name in prose').not.toMatch(
      /`edge`/
    );
  });

  it('keeps the connector reachable on the default network too, alongside edge-store', () => {
    // A `networks:` override REPLACES the implicit default network rather
    // than extending it -- without `default: {}` in the overlay, joining
    // `edge-store` would silently cut the connector off from the store.
    const merged = composeConfig([BASE, OVERLAY]);
    expect(merged.services['connector']?.networks?.['default']).toBeDefined();
    expect(merged.services['store']?.networks?.['default']).toBeDefined();
  });

  it('gives every one of its services a mem_limit, marked provisional', () => {
    const names = Object.keys(overlayYaml.services);
    expect(names.sort()).toEqual(
      ['certbot', 'connector', 'nginx', 'store', 'watchtower'].sort()
    );
    for (const [name, service] of Object.entries(overlayYaml.services)) {
      expect(service.mem_limit, `service "${name}" must set mem_limit`).toMatch(
        /^\d+[mg]$/i
      );
    }
    expect(
      readFileSync(`${deployDir}${OVERLAY}`, 'utf8'),
      'the mem_limit values must be flagged as provisional, pending real measurements'
    ).toMatch(/provisional/i);
  });

  it("does not undercut the store's own NODE_OPTIONS heap cap", () => {
    // docker-compose.yml caps the store's V8 heap at 384 MB
    // (--max-old-space-size=384); a container mem_limit at or below that
    // leaves no room for the non-heap part of the process and the box OOM
    // kills it under any real load.
    const baseCompose = readFileSync(`${deployDir}${BASE}`, 'utf8');
    const heapCapMatch = baseCompose.match(/--max-old-space-size=(\d+)/);
    expect(heapCapMatch, 'docker-compose.yml must still cap the store heap').not.toBeNull();
    const heapCapMb = Number(heapCapMatch![1]);

    const merged = composeConfig([BASE, OVERLAY]);
    const storeMemLimitBytes = Number(merged.services['store']?.mem_limit);
    expect(storeMemLimitBytes).toBeGreaterThan(heapCapMb * 1024 * 1024);
  });

  it('leaves the default bundle (no overlay) completely unchanged', () => {
    const withoutOverlay = composeConfig([BASE]);
    expect(Object.keys(withoutOverlay.services).sort()).toEqual(
      ['certbot', 'connector', 'nginx', 'store', 'watchtower'].sort()
    );

    // The public TLS edge still owns 80 and 443 by default.
    const nginxPorts = (withoutOverlay.services['nginx']?.ports ?? []).map(
      (p) => p.target
    );
    expect(nginxPorts.sort((a, b) => a - b)).toEqual([80, 443]);

    // No service carries an `edge-store` network, and nothing carries a
    // mem_limit -- both are the overlay's addition alone.
    for (const [name, service] of Object.entries(withoutOverlay.services)) {
      expect(
        service.networks?.['edge-store'],
        `service "${name}" must not be on "edge-store" without the overlay`
      ).toBeUndefined();
      expect(
        service.mem_limit,
        `service "${name}" must have no mem_limit without the overlay`
      ).toBeUndefined();
    }
    expect(withoutOverlay.networks?.['edge-store']).toBeUndefined();
  });
});
