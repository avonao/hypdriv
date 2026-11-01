import { describe, expect, it } from 'vitest';
import {
  binomialTwoSidedP,
  buildExperimentReport,
  chiSquareSurvival,
  experimentExposuresSql,
  experimentVitalsSql,
  sampleRatioCheck,
  sqlTimestamp,
} from './experiments';

describe('experiment SQL', () => {
  it('counts exposures per experiment and variant', () => {
    const sql = experimentExposuresSql('hypdriv_events', { days: 14 });
    expect(sql).toContain("blob1 = 'experiment.exposure'");
    expect(sql).toContain("INTERVAL '14' DAY");
    expect(sql).toContain('GROUP BY experiment, variant');
    expect(sql).not.toContain('blob2 =');
    expect(experimentExposuresSql('hypdriv_events', { days: 7, experiment: 'hero' })).toContain(
      "AND blob2 = 'hero'",
    );
  });

  it('slices vitals by the variant tag in blob8', () => {
    const sql = experimentVitalsSql('hypdriv_events', { days: 7, experiment: 'hero', variant: 'b' });
    expect(sql).toContain("position('|hero:b|' IN blob8) > 0");
    expect(sql).toContain("blob1 IN ('LCP', 'INP', 'CLS')");
    expect(sql).toContain('quantileWeighted(0.75, double1, _sample_interval)');
  });

  it('never writes NaN or Infinity into the window', () => {
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const exposures = experimentExposuresSql('d', { days: odd });
      expect(exposures).toContain("INTERVAL '14' DAY");
      expect(exposures).not.toMatch(/NaN|Infinity/);
      const vitals = experimentVitalsSql('d', { days: odd, experiment: 'x', variant: 'b' });
      expect(vitals).toContain("INTERVAL '14' DAY");
      expect(vitals).not.toMatch(/NaN|Infinity/);
    }
  });

  it('reads from an explicit moment when the window starts after a change', () => {
    const since = new Date('2026-10-30T12:34:56.789Z');
    expect(sqlTimestamp(since)).toBe('2026-10-30 12:34:56');
    expect(sqlTimestamp('2026-10-30')).toBe('2026-10-30 00:00:00');
    const exposures = experimentExposuresSql('d', { days: 14, since });
    expect(exposures).toContain("timestamp >= toDateTime('2026-10-30 12:34:56')");
    expect(exposures).not.toContain('INTERVAL');
    const vitals = experimentVitalsSql('d', { days: 14, since, experiment: 'x', variant: 'b' });
    expect(vitals).toContain("timestamp >= toDateTime('2026-10-30 12:34:56')");
    expect(() => experimentExposuresSql('d', { days: 14, since: "2026-10-30' OR 1=1" })).toThrow(/window/);
    expect(() => experimentExposuresSql('d', { days: 14, since: Number.NaN })).toThrow(/window/);
  });

  it('clamps the window and refuses anything that is not an identifier', () => {
    expect(experimentExposuresSql('d', { days: 500 })).toContain("INTERVAL '90' DAY");
    expect(experimentExposuresSql('d', { days: 0 })).toContain("INTERVAL '1' DAY");
    expect(() => experimentExposuresSql('d; DROP', { days: 7 })).toThrow(/dataset/);
    expect(() => experimentExposuresSql('d', { days: 7, experiment: "x' OR 1=1" })).toThrow(/experiment/);
    expect(() => experimentVitalsSql('d', { days: 7, experiment: 'x', variant: "b'|" })).toThrow(/variant/);
    expect(() => experimentVitalsSql('d', { days: 7, experiment: '', variant: 'b' })).toThrow(/experiment/);
  });
});

describe('chiSquareSurvival', () => {
  it('matches known critical values', () => {
    expect(chiSquareSurvival(3.841, 1)).toBeCloseTo(0.05, 3);
    expect(chiSquareSurvival(10.828, 1)).toBeCloseTo(0.001, 4);
    expect(chiSquareSurvival(5.991, 2)).toBeCloseTo(0.05, 3);
    expect(chiSquareSurvival(16.266, 3)).toBeCloseTo(0.001, 4);
    expect(chiSquareSurvival(0, 2)).toBe(1);
  });

  it('is NaN for nonsense', () => {
    expect(chiSquareSurvival(1, 0)).toBeNaN();
    expect(chiSquareSurvival(Number.POSITIVE_INFINITY, 1)).toBeNaN();
  });
});

describe('binomialTwoSidedP', () => {
  it('matches known exact values', () => {
    // 95 of 100 against 99 %: P(X <= 95) + P(X = 100), as R's binom.test(95, 100, 0.99) gives.
    expect(binomialTwoSidedP(95, 100, 0.99)).toBeCloseTo(0.0034, 3);
    // The mode is as likely as any outcome: nothing to be surprised about.
    expect(binomialTwoSidedP(50, 100, 0.5)).toBeCloseTo(1, 10);
    // 60 of 100 heads of a fair coin.
    expect(binomialTwoSidedP(60, 100, 0.5)).toBeCloseTo(0.0568, 3);
    expect(binomialTwoSidedP(0, 10, 0.5)).toBeCloseTo(2 / 1024, 12);
  });

  it('is symmetric for a fair split and NaN for nonsense', () => {
    expect(binomialTwoSidedP(13, 100, 0.5)).toBeCloseTo(binomialTwoSidedP(87, 100, 0.5), 12);
    expect(binomialTwoSidedP(1, 10, 0)).toBeNaN();
    expect(binomialTwoSidedP(11, 10, 0.5)).toBeNaN();
    expect(binomialTwoSidedP(1.5, 10, 0.5)).toBeNaN();
  });
});

describe('sampleRatioCheck', () => {
  const weights = { control: 50, b: 50 };

  it('uses the exact test where the expected count is below 5 (finding 8)', () => {
    // 95 / 5 against 99 / 1: chi-square says p = 6e-5 and flags it; the exact probability is 0.34 %.
    const r = sampleRatioCheck({ control: 95, b: 5 }, { control: 99, b: 1 });
    expect(r.method).toBe('exact');
    expect(r.status).toBe('ok');
    expect(r.chiSquare).toBeNull();
    expect(r.p).toBeCloseTo(0.0034, 3);
    // A split that is wrong even by the exact test is still flagged.
    const bad = sampleRatioCheck({ control: 80, b: 20 }, { control: 99, b: 1 });
    expect(bad.method).toBe('exact');
    expect(bad.status).toBe('mismatch');
    // Plenty of visitors for every variant: the usual test.
    expect(sampleRatioCheck({ control: 5040, b: 4960 }, weights).method).toBe('chi-square');
    expect(sampleRatioCheck({ control: 5040, b: 4960 }, weights).chiSquare).toBeGreaterThan(0);
  });

  it('corrects for the number of variants when one of several is expected to be rare', () => {
    const weights3 = { control: 98, b: 1, c: 1 };
    const fine = sampleRatioCheck({ control: 195, b: 3, c: 2 }, weights3);
    expect(fine.method).toBe('exact');
    expect(fine.status).toBe('ok');
    const off = sampleRatioCheck({ control: 150, b: 25, c: 25 }, weights3);
    expect(off.status).toBe('mismatch');
    expect(off.p).toBeLessThan(0.001);
    expect(sampleRatioCheck({ control: 195, b: 3, c: 2 }, weights3).p).toBeLessThanOrEqual(1);
  });

  it('accepts a split chance explains', () => {
    const r = sampleRatioCheck({ control: 5040, b: 4960 }, weights);
    expect(r.status).toBe('ok');
    expect(r.p).toBeGreaterThan(0.2);
  });

  it('flags a split it does not', () => {
    const r = sampleRatioCheck({ control: 5400, b: 4600 }, weights);
    expect(r.status).toBe('mismatch');
    expect(r.p).toBeLessThan(0.001);
  });

  it('respects unequal weights', () => {
    expect(sampleRatioCheck({ control: 9000, b: 1000 }, { control: 90, b: 10 }).status).toBe('ok');
    expect(sampleRatioCheck({ control: 5000, b: 5000 }, { control: 90, b: 10 }).status).toBe('mismatch');
  });

  it('says nothing about too few visitors or a single variant', () => {
    expect(sampleRatioCheck({ control: 30, b: 10 }, weights).status).toBe('insufficient');
    expect(sampleRatioCheck({ control: 5000 }, { control: 100 }).status).toBe('insufficient');
  });

  it('ignores variants with weight 0 and counts a missing variant as zero', () => {
    expect(sampleRatioCheck({ control: 10_000 }, { control: 50, b: 50 }).status).toBe('mismatch');
    expect(sampleRatioCheck({ control: 500, b: 500, off: 9000 }, { control: 50, b: 50, off: 0 }).status).toBe(
      'ok',
    );
  });
});

describe('buildExperimentReport', () => {
  const description = {
    name: 'hero',
    control: 'control',
    weights: { control: 50, b: 50 },
    status: 'running' as const,
  };

  it('puts the control first and compares every variant against it', () => {
    const report = buildExperimentReport(
      description,
      {
        exposures: [
          {
            experiment: 'hero',
            variant: 'b',
            visitors: 5010,
            first_seen: '2026-10-20 08:00:00',
            last_seen: '2026-10-31 20:00:00',
          },
          {
            experiment: 'hero',
            variant: 'control',
            visitors: 4990,
            first_seen: '2026-10-19 12:00:00',
            last_seen: '2026-10-31 21:00:00',
          },
          {
            experiment: 'other',
            variant: 'x',
            visitors: 99,
            first_seen: '2026-10-01 00:00:00',
            last_seen: '2026-10-02 00:00:00',
          },
        ],
        vitals: {
          control: [
            { metric: 'LCP', p75: 2000, samples: 4000 },
            { metric: 'CLS', p75: 0.05, samples: 4000 },
            { metric: 'TTFB', p75: 100, samples: 4000 },
          ],
          b: [
            { metric: 'LCP', p75: 1800, samples: 3900 },
            { metric: 'CLS', p75: 0.12, samples: 3900 },
          ],
        },
      },
      { days: 14 },
    );
    expect(report.visitors).toBe(10_000);
    expect(report.variants.map((v) => v.variant)).toEqual(['control', 'b']);
    const [control, b] = report.variants;
    expect(control?.isControl).toBe(true);
    expect(control?.share).toBeCloseTo(0.499);
    expect(control?.expectedShare).toBe(0.5);
    expect(control?.metrics.LCP).toEqual({ p75: 2000, samples: 4000, rating: 'good' });
    expect(control?.metrics.TTFB).toBeUndefined();
    expect(b?.metrics.LCP?.deltaVsControl).toBeCloseTo(-0.1);
    expect(b?.metrics.LCP?.rating).toBe('good');
    expect(b?.metrics.CLS?.deltaVsControl).toBeCloseTo(1.4);
    expect(b?.metrics.CLS?.rating).toBe('needs-improvement');
    expect(control?.metrics.LCP?.deltaVsControl).toBeUndefined();
    expect(report.sampleRatio.status).toBe('ok');
    expect(report.firstSeen).toBe(Date.parse('2026-10-19T12:00:00Z'));
    expect(report.lastSeen).toBe(Date.parse('2026-10-31T21:00:00Z'));
  });

  it('keeps a variant the experiment no longer defines, marked as such', () => {
    const report = buildExperimentReport(
      description,
      {
        exposures: [
          { experiment: 'hero', variant: 'control', visitors: 40, first_seen: null, last_seen: null },
          { experiment: 'hero', variant: 'old', visitors: 20, first_seen: null, last_seen: null },
        ],
        vitals: {},
      },
      { days: 7 },
    );
    const old = report.variants.find((v) => v.variant === 'old');
    expect(old).toMatchObject({ defined: false, visitors: 20, expectedShare: 0 });
    expect(report.firstSeen).toBeNull();
    expect(report.sampleRatio.status).toBe('insufficient');
  });

  it('reports an experiment nobody has seen yet', () => {
    const report = buildExperimentReport(
      { ...description, status: 'paused' },
      { exposures: [], vitals: {} },
      { days: 7 },
    );
    expect(report.visitors).toBe(0);
    expect(report.status).toBe('paused');
    expect(report.variants.map((v) => [v.variant, v.visitors, v.share])).toEqual([
      ['control', 0, 0],
      ['b', 0, 0],
    ]);
  });

  it('names the start of an explicit window', () => {
    const report = buildExperimentReport(
      description,
      { exposures: [], vitals: {} },
      { days: 3, since: '2026-10-30T12:00:00Z' },
    );
    expect(report.since).toBe('2026-10-30T12:00:00.000Z');
    expect(
      buildExperimentReport(description, { exposures: [], vitals: {} }, { days: 3 }).since,
    ).toBeUndefined();
  });

  it('carries the winner of a concluded experiment', () => {
    const report = buildExperimentReport(
      { ...description, status: 'concluded', winner: 'b' },
      { exposures: [], vitals: {} },
      { days: 7 },
    );
    expect(report.winner).toBe('b');
  });
});
