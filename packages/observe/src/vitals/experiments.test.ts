import { describe, expect, it } from 'vitest';
import {
  buildExperimentReport,
  chiSquareSurvival,
  experimentExposuresSql,
  experimentVitalsSql,
  sampleRatioCheck,
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

describe('sampleRatioCheck', () => {
  const weights = { control: 50, b: 50 };

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

  it('carries the winner of a concluded experiment', () => {
    const report = buildExperimentReport(
      { ...description, status: 'concluded', winner: 'b' },
      { exposures: [], vitals: {} },
      { days: 7 },
    );
    expect(report.winner).toBe('b');
  });
});
