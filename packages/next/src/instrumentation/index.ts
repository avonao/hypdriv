import { type HypDrivConfig, type Logger, type ResolvedConfig, loadConfig } from '@hypdriv/core';
import { createLogger, onRequestError as observeOnRequestError } from '@hypdriv/observe';

export interface InstrumentationOptions {
  config?: HypDrivConfig | ResolvedConfig;
  log?: Logger;
}

type RequestErrorHook = ReturnType<typeof observeOnRequestError>;

/**
 * Helpers for `instrumentation.ts`:
 *
 * ```ts
 * import { createInstrumentation } from '@hypdriv/next/instrumentation';
 * export const { register, onRequestError } = createInstrumentation();
 * ```
 */
export function createInstrumentation(options: InstrumentationOptions = {}): { register(): Promise<void>; onRequestError: RequestErrorHook } {
  const resolved = options.config && 'stages' in options.config && Array.isArray((options.config as ResolvedConfig).stages?.disable) ? (options.config as ResolvedConfig) : loadConfig((options.config as HypDrivConfig | undefined) ?? {});
  const log = options.log ?? createLogger(resolved.observe.logging, { service: resolved.site.name, component: 'instrumentation' });
  const hook = observeOnRequestError({ log, sink: resolved.observe.errors.sink, includeStack: resolved.observe.errors.includeStack });
  return {
    async register() {
      log.debug('hypdriv instrumentation registered', { runtime: process.env.NEXT_RUNTIME ?? 'nodejs' });
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
