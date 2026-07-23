/**
 * Gate speed/performance no-regression guard (ADR-0001, toon-meta#210 / store#57).
 *
 * Compares the gate's measured wall-clock and billed runner-minutes for the
 * current run against the frozen numbers in .sandcastle/gate-baseline.json.
 * Thresholds are fixed, baseline-relative multipliers (not live/rolling
 * numbers), so the same commit always earns the same verdict.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface GateBaseline {
  gateSpeed: {
    gateJobWallClockSeconds: number;
  };
  gatePerformance: {
    runnerMinutesBilled: {
      value: number | null;
    };
  };
}

export interface GateMeasurement {
  wallClockSeconds: number;
  runnerMinutesBilled: number;
}

export interface RegressionThresholds {
  /** Wall-clock fails once measured exceeds baseline * this multiplier. */
  wallClockMultiplier: number;
  /** Runner-minutes fails once measured exceeds baseline * this multiplier. */
  runnerMinutesMultiplier: number;
}

export const DEFAULT_THRESHOLDS: RegressionThresholds = {
  // Gate wall-clock is small (~25s baseline) and shared-runner noise is
  // proportionally large, so 2x baseline is the regression line, not 1.1x.
  wallClockMultiplier: 2.0,
  // Runner-minutes bill in whole-minute increments off a 1-minute baseline,
  // so a wider multiplier avoids false-failing on single-minute rounding noise.
  runnerMinutesMultiplier: 3.0,
};

export interface RegressionResult {
  pass: boolean;
  violations: string[];
}

export function evaluateGateRegression(
  baseline: GateBaseline,
  measured: GateMeasurement,
  thresholds: RegressionThresholds = DEFAULT_THRESHOLDS
): RegressionResult {
  const violations: string[] = [];

  const wallClockBaseline = baseline.gateSpeed.gateJobWallClockSeconds;
  const wallClockLimit = wallClockBaseline * thresholds.wallClockMultiplier;
  if (measured.wallClockSeconds > wallClockLimit) {
    violations.push(
      `gate wall-clock regressed: ${measured.wallClockSeconds}s > ${wallClockLimit}s limit ` +
        `(baseline ${wallClockBaseline}s x${thresholds.wallClockMultiplier})`
    );
  }

  const runnerMinutesBaseline = baseline.gatePerformance.runnerMinutesBilled.value;
  if (runnerMinutesBaseline !== null) {
    const runnerMinutesLimit = runnerMinutesBaseline * thresholds.runnerMinutesMultiplier;
    if (measured.runnerMinutesBilled > runnerMinutesLimit) {
      violations.push(
        `gate runner-minutes regressed: ${measured.runnerMinutesBilled}min > ${runnerMinutesLimit}min limit ` +
          `(baseline ${runnerMinutesBaseline}min x${thresholds.runnerMinutesMultiplier})`
      );
    }
  }

  return { pass: violations.length === 0, violations };
}

function runCli(): void {
  const baselinePath = process.env.GATE_BASELINE_PATH ?? '.sandcastle/gate-baseline.json';
  const wallClockSeconds = Number(process.env.GATE_WALL_CLOCK_SECONDS);
  if (!Number.isFinite(wallClockSeconds)) {
    console.error('gate-regression-guard: GATE_WALL_CLOCK_SECONDS must be set to a number');
    process.exit(2);
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as GateBaseline;
  const runnerMinutesBilled = Math.ceil(wallClockSeconds / 60);

  const result = evaluateGateRegression(baseline, {
    wallClockSeconds,
    runnerMinutesBilled,
  });

  if (result.pass) {
    console.log(
      `gate-regression-guard: PASS (wall-clock ${wallClockSeconds}s, runner-minutes ${runnerMinutesBilled})`
    );
    return;
  }

  console.error('gate-regression-guard: FAIL');
  for (const violation of result.violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runCli();
}
