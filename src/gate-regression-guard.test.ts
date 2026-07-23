import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  evaluateGateRegression,
  type GateBaseline,
} from './gate-regression-guard.js';

const baseline: GateBaseline = {
  gateSpeed: { gateJobWallClockSeconds: 25 },
  gatePerformance: { runnerMinutesBilled: { value: 1 } },
};

describe('evaluateGateRegression', () => {
  it('passes when measurements match the baseline exactly', () => {
    const result = evaluateGateRegression(baseline, {
      wallClockSeconds: 25,
      runnerMinutesBilled: 1,
    });
    expect(result).toEqual({ pass: true, violations: [] });
  });

  it('passes when measurements are within the baseline-relative threshold', () => {
    const result = evaluateGateRegression(baseline, {
      wallClockSeconds: 40,
      runnerMinutesBilled: 2,
    });
    expect(result.pass).toBe(true);
  });

  it('fails when wall-clock regresses beyond the multiplier', () => {
    const result = evaluateGateRegression(baseline, {
      wallClockSeconds: 100,
      runnerMinutesBilled: 1,
    });
    expect(result.pass).toBe(false);
    expect(result.violations).toEqual([
      `gate wall-clock regressed: 100s > 50s limit (baseline 25s x${DEFAULT_THRESHOLDS.wallClockMultiplier})`,
    ]);
  });

  it('fails when runner-minutes regress beyond the multiplier', () => {
    const result = evaluateGateRegression(baseline, {
      wallClockSeconds: 25,
      runnerMinutesBilled: 5,
    });
    expect(result.pass).toBe(false);
    expect(result.violations).toEqual([
      `gate runner-minutes regressed: 5min > 3min limit (baseline 1min x${DEFAULT_THRESHOLDS.runnerMinutesMultiplier})`,
    ]);
  });

  it('reports both violations when both metrics regress', () => {
    const result = evaluateGateRegression(baseline, {
      wallClockSeconds: 1000,
      runnerMinutesBilled: 20,
    });
    expect(result.pass).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it('skips the runner-minutes check when the baseline value is null (metric not applicable)', () => {
    const nullBaseline: GateBaseline = {
      gateSpeed: { gateJobWallClockSeconds: 25 },
      gatePerformance: { runnerMinutesBilled: { value: null } },
    };
    const result = evaluateGateRegression(nullBaseline, {
      wallClockSeconds: 25,
      runnerMinutesBilled: 999,
    });
    expect(result.pass).toBe(true);
  });

  it('is deterministic: the same baseline and measurement always produce the same verdict', () => {
    const measurement = { wallClockSeconds: 51, runnerMinutesBilled: 1 };
    const first = evaluateGateRegression(baseline, measurement);
    const second = evaluateGateRegression(baseline, measurement);
    expect(first).toEqual(second);
  });

  it('respects custom thresholds', () => {
    const result = evaluateGateRegression(
      baseline,
      { wallClockSeconds: 30, runnerMinutesBilled: 1 },
      { wallClockMultiplier: 1.0, runnerMinutesMultiplier: 1.0 }
    );
    expect(result.pass).toBe(false);
    expect(result.violations[0]).toContain('gate wall-clock regressed');
  });
});
