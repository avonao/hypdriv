import { type HypDrivConfig, type HypDrivEnv, type Logger, type ResolvedConfig, detectCapabilities, loadConfig } from '@hypdriv/core';
import { type NextOnRequestError, type RequestErrorEvent, type Tracer, createLogger, onRequestError as observeOnRequestError } from '@hypdriv/observe';
import { createConfiguredTracer } from '../stages';

export interface InstrumentationOptions {
  config?: HypDrivConfig | ResolvedConfig;
  log?: Logger;
  /** Extra forwarding target for normalised error events (error tracker, queue...). */
  sink?: (event: RequestErrorEvent) => void | Promise<void>;
  /** Environment used to resolve tracing credentials (default `process.env`). */
  env?: HypDrivEnv;
  /** Tracer override (default: built from `observe.tracing` when `observe.errors.sink` is `'otlp'`). */
  tracer?: Tracer | null;
}

function isResolved(config: HypDrivConfig | ResolvedConfig | undefined): config is ResolvedConfig {
  return !!config && 'stages' in config && Array.isArray((config as ResolvedConfig).stages?.disable);
}

/**
 * Helpers for `instrumentation.ts`:
 *
 * ```ts
 * import { createInstrumentation } from '@hypdriv/next/instrumentation';
 * import config from './hypdriv.config';
 * export const { register, onRequestError } = createInstrumentation({ config });
 * ```
 *
 * `observe.errors.sink`: `'log'` logs a redacted, structured error event; `'otlp'` additionally records
 * it as an exception span parented to the request's `traceparent`; `'none'` disables the hook.
 */
export function createInstrumentation(options: InstrumentationOptions = {}): { register(): Promise<void>; onRequestError: NextOnRequestError } {
  const resolved = isResolved(options.config) ? options.config : loadConfig((options.config as HypDrivConfig | undefined) ?? {});
  const log = options.log ?? createLogger(resolved.observe.logging, { service: resolved.site.name, component: 'instrumentation' });
  const errors = resolved.observe.errors;
  if (errors.sink === 'none') {
    return {
      async register() {},
      async onRequestError() {},
    };
  }
  const env = options.env ?? ((typeof process !== 'undefined' ? process.env : {}) as HypDrivEnv);
  let built: NextOnRequestError | null = null;
  // Built on first use so tracing credentials are read after `register()` and env population.
  const hook: NextOnRequestError = (error, request, context) => {
    if (!built) {
      let tracer = options.tracer;
      if (tracer === undefined) {
        tracer = errors.sink === 'otlp' ? createConfiguredTracer(resolved, env, detectCapabilities(env as Record<string, unknown>, resolved)) : null;
        if (errors.sink === 'otlp' && !tracer) log.warn('hypdriv: observe.errors.sink is "otlp" but observe.tracing is not configured; errors are logged only');
      }
      built = observeOnRequestError({
        log,
        includeStack: errors.includeStack,
        redactKeys: resolved.observe.logging.redact,
        ...(tracer ? { tracer } : {}),
        ...(options.sink ? { sink: options.sink } : {}),
      });
    }
    return built(error, request, context);
  };
  return {
    async register() {
      log.debug('hypdriv instrumentation registered', { runtime: (typeof process !== 'undefined' && process.env.NEXT_RUNTIME) || 'nodejs', errors: errors.sink });
    },
    onRequestError: hook,
  };
}

/**
 * Helper for `instrumentation-client.ts`: reports navigation timings to the console in development.
 * Returns the function to assign to `onRouterTransitionStart`.
 */
export function createClientInstrumentation(options: { log?: (message: string, fields: Record<string, unknown>) => void } = {}) {
  const log = options.log ?? ((m: string, f: Record<string, unknown>) => console.debug(m, f));
  let started = 0;
  return {
    onRouterTransitionStart(url: string, navigationType: string) {
      started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      log('hypdriv:navigation', { url, navigationType, startedAt: started });
    },
  };
}
