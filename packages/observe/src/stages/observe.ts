import {
  defineStage,
  HEADER,
  type HypContext,
  type ResolvedConfig,
  type Stage,
  type StateKey,
  stateKey,
} from '@hypdriv/core';
import type { Tracer } from '../trace/tracer';
import type { VitalsSink } from '../vitals/types';
import { cacheStatusOf, maskIp, ROOT_SPAN_KEY } from './shared';

export interface ObserveStageOptions {
  tracer?: Tracer;
  /** Exposed to request-scoped code through `VITALS_SINK_KEY` (the beacon endpoint itself is `vitalsHandler`). */
  vitalsSink?: VitalsSink;
}

/** The vitals sink the platform configured, for stages or handlers that run inside the pipeline. */
export const VITALS_SINK_KEY: StateKey<VitalsSink> = stateKey('vitals.sink');

/** How long the flush waits for the root span to end before exporting anyway. */
const ROOT_SPAN_WAIT_MS = 5000;

/** Flushes once the root span has ended (it ends in `request-id`'s post, which runs after ours). */
export function flushAfterRootSpan(ctx: HypContext, tracer: Tracer): Promise<void> {
  const root = ctx.state.get(ROOT_SPAN_KEY);
  if (!root || root.endTime !== undefined) return tracer.flush();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ROOT_SPAN_WAIT_MS);
    root.onEnd(() => {
      clearTimeout(timer);
      resolve();
    });
  }).then(() => tracer.flush());
}

/**
 * The `observe` stage (last in the Drivetrain): writes the request summary line when
 * `observe.logging.requests` is on and schedules the span export in `waitUntil`.
 */
export function observeStage(config: ResolvedConfig, options: ObserveStageOptions = {}): Stage {
  return defineStage({
    name: 'observe',
    runOnInternal: true,
    pre(ctx) {
      if (options.vitalsSink) ctx.state.set(VITALS_SINK_KEY, options.vitalsSink);
    },
    post(ctx, response) {
      if (config.observe.logging.requests) {
        const bot = response.headers.get(HEADER.bot) ?? ctx.responseHeaders.get(HEADER.bot);
        ctx.log.info('request', {
          method: ctx.request.method,
          path: ctx.url.pathname,
          status: response.status,
          duration: Math.round(ctx.timings.elapsed() * 10) / 10,
          route: ctx.route?.route.id,
          cache: cacheStatusOf(ctx, response),
          ...(bot ? { bot } : {}),
          ip: maskIp(ctx.ip),
          runner: ctx.runner,
        });
      }
      if (options.tracer) ctx.waitUntil(flushAfterRootSpan(ctx, options.tracer));
      return response;
    },
  });
}
