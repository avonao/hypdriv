import type { ResolvedConfig, ServerTimingMode } from '@hypdriv/core';

/** Resolves `observe.serverTiming`: `auto` is verbose in development and compact otherwise (ADR 0008). */
export function serverTimingMode(config: ResolvedConfig, development: boolean): ServerTimingMode {
  const mode = config.observe.serverTiming;
  if (mode === 'auto') return development ? 'verbose' : 'compact';
  return mode;
}
