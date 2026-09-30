import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The no-op merge guard (.github/scripts/no-op-merge-guard.sh) fails a PR whose
 * merge result changes zero files and passes one with a real diff. The script
 * runs from a checkout of refs/pull/N/merge, so build that shape by hand: a
 * merge commit whose first parent is the base tip and second is the PR head.
 */

const script = fileURLToPath(
  new URL('../.github/scripts/no-op-merge-guard.sh', import.meta.url)
);
const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * The PR head rewrites f.txt. With `alreadyLanded`, main has landed the same
 * content (the connector#1008 shape), so the merge result equals main;
 * otherwise main moves on with an unrelated file.
 */
function setup(alreadyLanded: boolean): { cwd: string; head: string } {
  const cwd = mkdtempSync(`${tmpdir()}/noop-guard-`);
  dirs.push(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com');
  git(cwd, 'config', 'user.name', 't');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  writeFileSync(`${cwd}/f.txt`, 'old\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'checkout', '-qb', 'pr');
  writeFileSync(`${cwd}/f.txt`, 'new\n');
  git(cwd, 'commit', '-qam', 'pr change');
  const head = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'checkout', '-q', 'main');
  if (alreadyLanded) {
    writeFileSync(`${cwd}/f.txt`, 'new\n');
    git(cwd, 'commit', '-qam', 'same change landed elsewhere');
  } else {
    writeFileSync(`${cwd}/g.txt`, 'unrelated\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'unrelated');
  }
  git(cwd, 'merge', '-q', '--no-ff', '-m', 'merge', head);
  return { cwd, head };
}

function run(cwd: string, head: string, event = 'pull_request') {
  return spawnSync('bash', [script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_STEP_SUMMARY: `${cwd}/summary.md`,
      PR_HEAD_SHA: head,
      PR_BASE_REF: 'main',
      PR_NUMBER: '1',
      PR_CHANGED_FILES: '1',
    },
  });
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('no-op merge guard', () => {
  it('fails a PR whose merge result changes nothing', () => {
    const { cwd, head } = setup(true);
    const r = run(cwd, head);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('EMPTY commit');
  });

  it('passes a PR with a real diff', () => {
    const { cwd, head } = setup(false);
    const r = run(cwd, head);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✓ merging this PR changes');
  });

  it('passes on push, where there is no merge result to evaluate', () => {
    const { cwd, head } = setup(true);
    expect(run(cwd, head, 'push').status).toBe(0);
  });
});
