// The gate, run DETERMINISTICALLY by the runner, not asked of the agent.
//
// `implement-prompt.md` tells the agent to run these commands before it commits, but
// that is advice the agent reports on itself. The runner runs them and won't open a PR
// while they are red. The same reasoning moved `git push` out of the agent's hands.
//
// The steps are CI's own. `ci.yml`'s `build` job runs `pnpm install --frozen-lockfile`
// (the sandbox's onSandboxReady hook does that here) and then build, typecheck, lint and
// test, in that order. `.sandcastle/agent-factory.test.ts` fails if this list and that job
// drift apart, because a gate that runs something similar to CI teaches the agent the
// wrong lesson.
//
// One CI step is left out on purpose: `src/gate-regression-guard.ts`. It measures how
// long the hosted `build` job took against a frozen baseline. CI runs the four commands
// in parallel and this runs them one at a time inside a sandbox, so its wall-clock is not
// comparable and the guard would fail for a reason that says nothing about the change.

import type * as sandcastle from '@ai-hero/sandcastle';

type Sandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;

export interface GateStep {
  readonly name: string;
  readonly command: string;
}

export interface GateFailure {
  readonly step: string;
  readonly command: string;
  readonly exitCode: number;
  /** Tail of combined output: enough for an agent to act on, bounded so it cannot blow a prompt. */
  readonly output: string;
}

export interface GateResult {
  readonly passed: boolean;
  readonly ran: readonly string[];
  readonly failure: GateFailure | null;
}

/** Keep fed-back output useful but bounded. */
const MAX_OUTPUT_CHARS = 12_000;

/** ci.yml's `build` job: `for step in build typecheck lint test; do pnpm "$step"`. */
export const GATE_STEPS: readonly GateStep[] = [
  { name: 'pnpm build', command: 'pnpm build' },
  { name: 'pnpm typecheck', command: 'pnpm typecheck' },
  { name: 'pnpm lint', command: 'pnpm lint' },
  { name: 'pnpm test', command: 'pnpm test' },
];

/**
 * Run `steps` in order, stopping at the first failure.
 *
 * Failure is returned, not thrown, so the caller can decide between a fix
 * iteration and failing the job.
 */
export async function runGate(
  sandbox: Sandbox,
  steps: readonly GateStep[] = GATE_STEPS
): Promise<GateResult> {
  const ran: string[] = [];
  for (const step of steps) {
    console.log(`  [gate] ${step.name}: ${step.command}`);
    const lines: string[] = [];
    const result = await sandbox.exec(step.command, {
      onLine: (line) => {
        lines.push(line);
        // Stream sparingly: full build output would bury the runner log.
        if (lines.length <= 40) console.log(`    | ${line}`);
      },
    });
    ran.push(step.name);
    if (result.exitCode !== 0) {
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const output =
        combined.length > MAX_OUTPUT_CHARS
          ? `...(truncated to the last ${MAX_OUTPUT_CHARS} chars)...\n` +
            combined.slice(-MAX_OUTPUT_CHARS)
          : combined;
      console.log(`  [gate] FAILED at ${step.name} (exit ${result.exitCode}).`);
      return {
        passed: false,
        ran,
        failure: { step: step.name, command: step.command, exitCode: result.exitCode, output },
      };
    }
  }
  console.log(`  [gate] PASSED (${ran.length} step(s): ${ran.join(', ')}).`);
  return { passed: true, ran, failure: null };
}

/** The prompt handed to a fix iteration. Concrete failure, no room to reinterpret the task. */
export function fixPrompt(failure: GateFailure, attempt: number, maxAttempts: number): string {
  return [
    `The repository gate is RED. This is fix attempt ${attempt} of ${maxAttempts}.`,
    '',
    `Failing step: ${failure.step}`,
    `Command:      ${failure.command}`,
    `Exit code:    ${failure.exitCode}`,
    '',
    'Output:',
    '```',
    failure.output,
    '```',
    '',
    'Fix the cause and commit. Rules:',
    `- Re-run \`${failure.command}\` yourself and confirm it passes before you finish.`,
    '- Fix the code. Do NOT weaken, skip or delete a test, and do not loosen a lint to make',
    '  this pass. If the test is genuinely wrong, say so explicitly in the commit message and',
    '  explain why.',
    '- Change only what this failure requires. Do not refactor beyond it.',
    '- If you cannot fix it, commit nothing and explain what is blocking you.',
  ].join('\n');
}
