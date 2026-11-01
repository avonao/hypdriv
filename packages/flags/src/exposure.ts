import type { AnalyticsEngineLike, Logger } from '@hypdriv/core';

/** The metric name exposures carry in Analytics Engine (`blob1`); vitals and trace rows use other values. */
export const EXPOSURE_METRIC = 'experiment.exposure';

/**
 * A visitor seen in an experiment, reported once per visitor and experiment. No visitor id is stored: counting
 * the rows (sample-weighted) counts the visitors.
 */
export interface ExposureEvent {
  experiment: string;
  variant: string;
  pathname: string;
  route?: string;
  country?: string;
  buildId?: string;
  /** Epoch milliseconds. */
  ts: number;
}

export type ExposureSink = (event: ExposureEvent) => void | Promise<void>;

/** The zero-infrastructure sink: one `experiment exposure` log line. */
export function logExposureSink(log: Logger): ExposureSink {
  return (event) => log.info('experiment exposure', { ...event });
}

/**
 * Analytics Engine sink: index `[experiment]`, blobs `['experiment.exposure', experiment, variant, pathname, route,
 * country, buildId]`, doubles `[ts]`. `hypdriv experiments` reads this layout.
 */
export function analyticsEngineExposureSink(binding: AnalyticsEngineLike): ExposureSink {
  return (event) => {
    binding.writeDataPoint({
      indexes: [event.experiment.slice(0, 96)],
      blobs: [
        EXPOSURE_METRIC,
        event.experiment,
        event.variant,
        event.pathname.slice(0, 1024),
        event.route ?? '',
        event.country ?? '',
        event.buildId ?? '',
      ],
      doubles: [event.ts],
    });
  };
}

/** Fans out to several sinks; a failing sink never blocks the others or the response. */
export function multiExposureSink(sinks: ExposureSink[]): ExposureSink {
  return async (event) => {
    await Promise.allSettled(sinks.map(async (sink) => sink(event)));
  };
}
