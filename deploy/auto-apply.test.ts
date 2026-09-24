/**
 * deploy/auto-apply.sh, run for real -- against a real git remote and a real
 * box checkout, with `docker` and `curl` stubbed on PATH so the box never
 * needs a live daemon or a live connector to prove what THIS script does with
 * what they answer. render.sh itself is real.
 *
 * TOON_Network#160 (provider, gateway) found that a render or apply failure
 * after a fast-forward used to be invisible on the NEXT run: `git fetch`
 * brought back nothing new, so "LOCAL = REMOTE" alone read as "nothing to
 * do", and the box sat on the new commit with the OLD rendered config and
 * containers, reporting success forever. Store's own auto-apply.sh even
 * documented the resulting state in a comment ("one red apply, then green
 * forever on an unverified box"). TOON_Network#164 ports the same fix here:
 * `deploy/.applied` (gitignored) names the last commit a run actually
 * finished applying AND verifying, written only at the very end, so the NEXT
 * run compares HEAD to that -- not to what fetch just brought back -- and
 * retries, and reports, the exact same failure on every run until it is
 * fixed.
 *
 * The first test is the fixture the issue asks for: a render that fails once
 * after a fast-forward (a newly-required .env variable, the same shape as
 * TOON_Network#152's own regression), retried and reported loudly by the very
 * next run even though that run's fetch brings back nothing new, and finally
 * applied once the variable is added. The second covers the box that has
 * never written .applied at all.
 */
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const envExample = readFileSync(join(HERE, '.env.example'), 'utf8');

const ENV: Record<string, string> = {
  DOMAIN: 'fixture.example',
  LETSENCRYPT_EMAIL: 'you@fixture.example',
  LETSENCRYPT_STAGING: '1',
  STORE_NOSTR_SECRET_KEY:
    '1111111111111111111111111111111111111111111111111111111111111111',
  OPERATOR_BEARER_TOKEN:
    '2222222222222222222222222222222222222222222222222222222222222222',
  OPERATOR_WRITE_KEY:
    '3333333333333333333333333333333333333333333333333333333333333333',
};

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function git(args: string[], cwd: string | undefined): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(r.status, `git ${args.join(' ')} in ${cwd}:\n${r.stderr}`).toBe(0);
  return r.stdout;
}

function commitAll(dir: string, message: string): string {
  git(['add', '-A'], dir);
  git(
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      message,
    ],
    dir
  );
  return git(['rev-parse', 'HEAD'], dir).trim();
}

// A repository shaped like the real one: deploy/ under the repo root, since
// that is what auto-apply.sh's own `dirname "$0")/..` assumes.
function freshOrigin(): { dir: string; sha: string } {
  const dir = tmp('store-origin-');
  const deploy = join(dir, 'deploy');
  mkdirSync(deploy, { recursive: true });
  for (const name of [
    'auto-apply.sh',
    'render.sh',
    'connector.toml.template',
    'docker-compose.yml',
    '.env.example',
    '.gitignore',
  ]) {
    cpSync(join(HERE, name), join(deploy, name));
  }
  mkdirSync(join(deploy, 'nginx'));
  cpSync(
    join(HERE, 'nginx/node.conf.template'),
    join(deploy, 'nginx/node.conf.template')
  );
  for (const name of ['auto-apply.sh', 'render.sh']) {
    chmodSync(join(deploy, name), 0o755);
  }
  git(['init', '--quiet', '-b', 'main'], dir);
  const sha = commitAll(dir, 'bundle');
  return { dir, sha };
}

function cloneBox(originDir: string): string {
  const dir = tmp('store-box-');
  git(['clone', '--quiet', originDir, dir], undefined);
  return dir;
}

/** A commit that adds a newly-required .env variable to render.sh -- the
 * exact shape of the regression TOON_Network#152 found: a fast-forward whose
 * render needs something the box's own .env does not have. */
function addFixtureRequiredVar(originDir: string): string {
  const path = join(originDir, 'deploy', 'render.sh');
  const before = readFileSync(path, 'utf8');
  const marker = 'set -a; . ./.env; set +a\n';
  expect(
    before.includes(marker),
    'render.sh no longer sources .env the expected way'
  ).toBe(true);
  const after = before.replace(
    marker,
    `${marker}\n: "\${STORE_FIXTURE_FLAG:?set STORE_FIXTURE_FLAG in .env (deploy/.env.example lists every required variable; this one is a TOON_Network#164 test fixture)}"\n`
  );
  writeFileSync(path, after);
  return commitAll(originDir, 'render.sh now needs STORE_FIXTURE_FLAG');
}

function writeEnv(boxDir: string, values: Record<string, string>): void {
  let env = `${envExample}\n# -- appended by deploy/auto-apply.test.ts --\n`;
  for (const [name, value] of Object.entries(values)) {
    env += `${name}=${value}\n`;
  }
  writeFileSync(join(boxDir, 'deploy', '.env'), env);
}

// ── The stubbed world: docker and curl on PATH ──────────────────────────────
// Every call auto-apply.sh itself makes (ps -q, pull, up -d, restart, exec,
// logs, inspect), plus a curl stub that answers GET /ilp from whatever
// connector.toml auto-apply.sh just rendered in its own working directory --
// so a real render change is what a "different served address" would mean.
const DOCKER_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
if [ "\${1:-}" = compose ]; then
  shift
  if [ "\${1:-}" = -f ]; then shift 2; fi
  rest="$*"
  case "$rest" in
    "ps -q "*) svc=\${rest#ps -q }; echo "cid-$svc"; exit 0 ;;
    "pull") exit "\${STUB_PULL_EXIT:-0}" ;;
    "up -d") exit "\${STUB_UP_EXIT:-0}" ;;
    "restart "*) exit "\${STUB_RESTART_EXIT:-0}" ;;
    "logs --tail 40 "*) exit 0 ;;
    "exec -T nginx nginx -s reload") exit "\${STUB_NGINX_RELOAD_EXIT:-0}" ;;
  esac
  echo "stub docker: unexpected compose call: $rest" >&2
  exit 97
fi
if [ "\${1:-}" = inspect ]; then echo "\${STUB_HEALTH:-healthy}"; exit 0; fi
echo "stub docker: unexpected call: $*" >&2
exit 97
`;

const CURL_STUB = `#!/usr/bin/env bash
url="\${@: -1}"
case "$url" in
  http://127.0.0.1:*/ilp)
    addr=$(sed -n '/^\\[node\\]/,/^\\[/s/^[[:space:]]*addresses[[:space:]]*=[[:space:]]*\\[\\(.*\\)\\].*/\\1/p' connector.toml | head -n1)
    printf '{"ilpAddresses":[%s]}\\n' "$addr"
    exit 0
    ;;
esac
echo "stub curl: unexpected call: $*" >&2
exit 7
`;

let stubBin: string;
beforeAll(() => {
  stubBin = tmp('store-stub-bin-');
  writeFileSync(join(stubBin, 'docker'), DOCKER_STUB);
  writeFileSync(join(stubBin, 'curl'), CURL_STUB);
  chmodSync(join(stubBin, 'docker'), 0o755);
  chmodSync(join(stubBin, 'curl'), 0o755);
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string;
}

let runs = 0;
function autoApply(boxDir: string): Run {
  const log = join(boxDir, `stub-log-${runs++}`);
  writeFileSync(log, '');
  const env = {
    ...process.env,
    PATH: `${stubBin}:${process.env.PATH}`,
    STUB_LOG: log,
    TOON_AUTOAPPLY_LOCK: join(boxDir, '.autoapply.lock'),
  };
  const r = spawnSync('bash', [join(boxDir, 'deploy', 'auto-apply.sh')], {
    env,
    encoding: 'utf8',
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: readFileSync(log, 'utf8'),
  };
}

function applied(boxDir: string): string | null {
  try {
    return readFileSync(join(boxDir, 'deploy', '.applied'), 'utf8').trim();
  } catch {
    return null;
  }
}

function headSha(dir: string): string {
  return git(['rev-parse', 'HEAD'], dir).trim();
}

describe('a render that fails once after a fast-forward (TOON_Network#164, porting TOON_Network#160)', () => {
  it('is retried and reported on every run -- even one whose fetch brings back nothing new -- and applies once .env is fixed', () => {
    const origin = freshOrigin();
    const box = cloneBox(origin.dir);
    writeEnv(box, ENV);

    // Run 1: the box is already on the only commit there is, and has never
    // written .applied. Treated as needing an apply (the safer of the two
    // readings), and it succeeds.
    const first = autoApply(box);
    expect(
      first.status,
      `run 1 (no .applied yet) should apply cleanly:\n${first.stdout}\n${first.stderr}`
    ).toBe(0);
    expect(applied(box)).toBe(origin.sha);

    // The bundle moves on: render.sh now needs a variable this box's .env
    // does not have -- exactly TOON_Network#152's shape of regression.
    const brokenSha = addFixtureRequiredVar(origin.dir);

    // Run 2: the fetch brings back real work, the fast-forward succeeds, and
    // render.sh fails on the missing variable.
    const second = autoApply(box);
    expect(second.status, 'a render failure must fail the apply').not.toBe(0);
    expect(
      headSha(box),
      'the fast-forward still happens; only the render fails'
    ).toBe(brokenSha);
    expect(second.stderr).toContain('STORE_FIXTURE_FLAG');
    expect(second.stderr).toContain('FAILED: render.sh');
    expect(second.stderr.toLowerCase()).toContain('.env.example');
    expect(
      applied(box),
      '.applied must still name the last commit that DID apply'
    ).toBe(origin.sha);

    // Run 3: nothing new to fetch (the box is already on the broken commit),
    // but HEAD still disagrees with .applied. Before TOON_Network#160/#164
    // this read as "nothing to do" and exited 0 silently; now it must retry,
    // and fail the same way, every time.
    const third = autoApply(box);
    expect(
      third.status,
      'the SAME failure must be reported again on a fetch that brings back nothing new'
    ).not.toBe(0);
    expect(third.stdout).toMatch(/retrying/);
    expect(third.stderr).toContain('STORE_FIXTURE_FLAG');
    expect(applied(box), 'still untouched after a second failed run').toBe(
      origin.sha
    );

    // The operator fixes it exactly as the message says: add the variable to
    // their own .env.
    writeEnv(box, { ...ENV, STORE_FIXTURE_FLAG: 'ok' });

    // Run 4: same commit, same "nothing to fetch" situation as run 3, but now
    // it applies -- because .applied still disagreed with HEAD, this run was
    // never going to be skipped.
    const fourth = autoApply(box);
    expect(
      fourth.status,
      `run 4 (fixed .env) should apply cleanly:\n${fourth.stdout}\n${fourth.stderr}`
    ).toBe(0);
    expect(fourth.stdout).toMatch(/applied/);
    expect(
      applied(box),
      '.applied now names the commit that finally succeeded'
    ).toBe(brokenSha);

    // Run 5: fully quiescent. Nothing to fetch, and .applied already agrees
    // with HEAD -- back to the quiet, common case, with no docker call at
    // all.
    const fifth = autoApply(box);
    expect(fifth.status).toBe(0);
    expect(
      fifth.calls,
      'a fully-applied box calls docker for nothing'
    ).toBe('');
  });
});

describe('a box with no deploy/.applied at all', () => {
  it('treats it as needing an apply, not as already applied, and writes it once healthy', () => {
    const origin = freshOrigin();
    const box = cloneBox(origin.dir);
    writeEnv(box, ENV);

    expect(
      applied(box),
      'a fresh clone has never written .applied'
    ).toBeNull();

    const result = autoApply(box);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(
      applied(box),
      'the first run writes .applied once the apply is verified healthy'
    ).toBe(origin.sha);
    expect(
      result.calls,
      'it actually ran the apply, not a silent no-op'
    ).toMatch(/ps -q connector/);
  });
});
