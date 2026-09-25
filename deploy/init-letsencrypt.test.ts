/**
 * deploy/init-letsencrypt.sh -- run for real, with `docker` stubbed on PATH
 * so a call to it is a hard failure rather than a silent success. This is
 * the seam store#137's shared-edge overlay adds a branch at: under
 * the overlay, nginx and certbot are disabled (docker-compose.shared-edge.yml)
 * and the shared edge terminates TLS instead (infra#24), so this script has
 * no certificate to issue or renew and must do NOTHING -- not even ask for
 * DOMAIN or LETSENCRYPT_EMAIL, which a hand-run overlay box may never set.
 *
 * Without the overlay, nothing about this script may change: it must still
 * refuse a `.env` missing DOMAIN/LETSENCRYPT_EMAIL exactly as it always has.
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, afterAll } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, 'init-letsencrypt.sh'), 'utf8');

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// `docker` on PATH exits loudly: the skip path must never reach it, and the
// unchanged-default path must fail on the missing .env variable before it
// ever would either.
const DOCKER_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
echo "stub docker: should not have been called" >&2
exit 99
`;

function runInitLetsencrypt(env: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
  dockerCalled: boolean;
} {
  const dir = mkdtempSync(join(tmpdir(), 'store-init-le-'));
  scratch.push(dir);
  writeFileSync(join(dir, 'init-letsencrypt.sh'), SCRIPT);
  chmodSync(join(dir, 'init-letsencrypt.sh'), 0o755);

  const stubBin = mkdtempSync(join(tmpdir(), 'store-init-le-stub-'));
  scratch.push(stubBin);
  writeFileSync(join(stubBin, 'docker'), DOCKER_STUB);
  chmodSync(join(stubBin, 'docker'), 0o755);

  let envFile = '';
  for (const [name, value] of Object.entries(env)) {
    envFile += `${name}=${value}\n`;
  }
  writeFileSync(join(dir, '.env'), envFile);

  const log = join(dir, 'docker-calls.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [join(dir, 'init-letsencrypt.sh')], {
    cwd: dir,
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}`, STUB_LOG: log },
    encoding: 'utf8',
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    dockerCalled: readFileSync(log, 'utf8').trim().length > 0,
  };
}

describe('deploy/init-letsencrypt.sh under the shared-edge overlay (store#137)', () => {
  it('skips all cert work -- and never even requires DOMAIN/LETSENCRYPT_EMAIL -- when COMPOSE_FILE names the overlay', () => {
    const result = runInitLetsencrypt({
      COMPOSE_FILE: 'docker-compose.yml:docker-compose.shared-edge.yml',
      // Deliberately no DOMAIN, no LETSENCRYPT_EMAIL: an overlay box may
      // never set either, since this box's own nginx never runs.
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/shared edge overlay/);
    expect(result.dockerCalled, 'the skip path must never touch docker').toBe(false);
  });

  it('still requires DOMAIN and LETSENCRYPT_EMAIL, exactly as before, when the overlay is not named', () => {
    const result = runInitLetsencrypt({});
    expect(result.status, 'a missing DOMAIN must still fail the script').not.toBe(0);
    expect(result.stderr).toContain('set DOMAIN in .env');
    expect(result.dockerCalled).toBe(false);
  });

  it("does not skip on a COMPOSE_FILE that merely mentions the overlay's name as a substring", () => {
    // A prefix/substring match here would also skip for an unrelated file
    // like docker-compose.shared-edge.yml.bak or a typo'd
    // "docker-compose.not-shared-edge.yml"; the check must be exact.
    const result = runInitLetsencrypt({
      COMPOSE_FILE: 'docker-compose.yml:docker-compose.shared-edge.yml.bak',
    });
    expect(result.status, 'an unrelated COMPOSE_FILE entry must not trigger the skip').not.toBe(
      0
    );
    expect(result.stderr).toContain('set DOMAIN in .env');
  });
});

describe('deploy/bootstrap.sh delegates the overlay skip to init-letsencrypt.sh', () => {
  // bootstrap.sh provisions a host (apt-get, ufw, systemd) and cannot safely
  // run in CI, so this asserts its STRUCTURE rather than executing it -- the
  // same style src/deploy-bundle-guard.test.ts already uses for auto-apply.sh.
  const BOOTSTRAP = readFileSync(join(HERE, 'bootstrap.sh'), 'utf8');

  it('always calls ./init-letsencrypt.sh, unconditionally, for both the overlay and the default case', () => {
    expect(BOOTSTRAP).toMatch(/^\.\/init-letsencrypt\.sh\s*$/m);
  });

  it("reports the overlay's own summary instead of URLs this box's disabled nginx would no longer serve", () => {
    expect(BOOTSTRAP).toMatch(/COMPOSE_FILE/);
    expect(BOOTSTRAP).toMatch(/docker-compose\.shared-edge\.yml/);
  });
});
