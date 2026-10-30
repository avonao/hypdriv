import type { AnalyticsEngineLike, Logger } from '@hypdriv/core';
import type { VitalsSink } from './types';

/** Logs one `vitals` line per metric (the zero-infrastructure sink). */
export function logVitalsSink(log: Logger): VitalsSink {
  return {
    write(p, ctx) {
      const { attribution, ...rest } = p;
      log.info('vitals', {
        ...rest,
        ...(attribution ? { attribution } : {}),
        ...(ctx.country ? { country: ctx.country } : {}),
      });
    },
  };
}

/**
 * Analytics Engine sink: index `[route]`, blobs `[name, rating, pathname, navigationType, buildId, cache, country]`,
 * doubles `[value, ts]`. `hypdriv vitals` reads p75 per route from this layout.
 */
export function analyticsEngineVitalsSink(binding: AnalyticsEngineLike): VitalsSink {
  return {
    write(p, ctx) {
      binding.writeDataPoint({
        indexes: [(p.route ?? p.pathname).slice(0, 96)],
        blobs: [
          p.name,
          p.rating,
          p.pathname.slice(0, 1024),
          p.navigationType ?? '',
          p.buildId ?? '',
          p.cache ?? '',
          ctx.country ?? '',
        ],
        doubles: [p.value, p.ts],
      });
    },
  };
}

/** Fans out to several sinks; one failing sink never blocks the others. */
export function multiVitalsSink(sinks: VitalsSink[]): VitalsSink {
  return {
    async write(p, ctx) {
      await Promise.allSettled(sinks.map(async (s) => s.write(p, ctx)));
    },
  };
}

/** Wraps a plain function as a sink. */
export function functionVitalsSink(fn: VitalsSink['write']): VitalsSink {
  return { write: fn };
}
