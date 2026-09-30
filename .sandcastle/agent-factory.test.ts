/**
 * Guards over the AFK factory (toon-protocol/store#148).
 *
 * The runner's gate must be `ci.yml`'s `build` job, or a green run teaches the agent
 * that something similar to CI is good enough. `blockersInBody` decides which
 * ready-for-agent issues an agent may start, so a wrong parse starts blocked work.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { blockersInBody } from './ready-issues.ts';
import { GATE_STEPS } from './run-gate.ts';

function ciBuildRun(): string {
  const ci = parseYaml(readFileSync('.github/workflows/ci.yml', 'utf-8')) as {
    jobs: { build: { steps: { run?: string }[] } };
  };
  return ci.jobs.build.steps.map((s) => s.run ?? '').join('\n');
}

describe('the runner gate is ci.yml build job', () => {
  it('runs the steps CI loops over, in the same order', () => {
    const loop = /for step in ([a-z ]+); do\s+pnpm "\$step"/.exec(ciBuildRun());
    expect(loop, 'ci.yml no longer loops `pnpm "$step"` over its gate steps').not.toBeNull();
    const ciSteps = loop![1]!.trim().split(/\s+/);
    expect(GATE_STEPS.map((s) => s.command)).toEqual(ciSteps.map((s) => `pnpm ${s}`));
  });

  it('is preceded in CI by a frozen-lockfile install, which the runner hook mirrors', () => {
    expect(ciBuildRun()).toContain('pnpm install --frozen-lockfile');
    const runner = readFileSync('.sandcastle/agent-implement-issue.ts', 'utf-8');
    expect(runner).toContain("command: 'pnpm install --frozen-lockfile'");
  });
});

describe('nothing in the repo names a retired label', () => {
  const retired = ['agent:implement', 'agent:review', 'agent:fix', 'needs:human'];
  // The label docs say which are retired, and this file lists them.
  const exempt = new Set(['docs/agents/triage-labels.md', '.sandcastle/agent-factory.test.ts']);
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf-8' })
    .split('\n')
    .filter((f) => f && !exempt.has(f) && existsSync(f) && !/\.(png|jpg|gz)$/.test(f));
  it.each(files)('%s', (file) => {
    const text = readFileSync(file, 'utf-8');
    for (const label of retired) expect(text).not.toContain(label);
  });
});

describe('blockersInBody', () => {
  it('reads issue numbers under a Blocked by heading, up to the next heading', () => {
    const body = '## What\n\nsee #9\n\n## Blocked by\n\n- #3\n- #4 and org/repo#5\n\n## Notes\n#6';
    expect(blockersInBody(body)).toEqual([3, 4]);
  });

  it('is empty when there is no such heading', () => {
    expect(blockersInBody('## What\n\nblocked by #1 in prose')).toEqual([]);
  });

  it('is empty for "None"', () => {
    expect(blockersInBody('## Blocked by\n\n- None (can start immediately)')).toEqual([]);
  });
});
