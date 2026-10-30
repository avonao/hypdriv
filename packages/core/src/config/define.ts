import { HypDrivError } from '../util/errors';
import { resolveConfig } from './resolve';
import type { ResolvedConfig } from './resolved';
import type { HypDrivConfig } from './types';
import { type ConfigDiagnostic, validateConfig } from './validate';

const RESOLVED = Symbol.for('hypdriv.resolved');

/** A config object returned by `defineConfig()`; it carries a lazily computed resolved form. */
export interface DefinedConfig extends HypDrivConfig {
  readonly [RESOLVED]?: ResolvedConfig;
}

/**
 * Type-safe helper for `hypdriv.config.ts`. Validates eagerly in development/build (throws on errors)
 * and returns the input object unchanged so it stays serialisable.
 */
export function defineConfig(config: HypDrivConfig): HypDrivConfig {
  const diagnostics = validateConfig(config);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new HypDrivError('E_CONFIG', formatDiagnostics(errors), { diagnostics: errors });
  return config;
}

/** Validates and resolves a config in one step (what runtimes use). Throws on validation errors. */
export function loadConfig(
  config: HypDrivConfig | undefined,
  options: { onWarning?: (d: ConfigDiagnostic) => void } = {},
): ResolvedConfig {
  const input = config ?? {};
  const cached = (input as DefinedConfig)[RESOLVED];
  if (cached) return cached;
  const diagnostics = validateConfig(input);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new HypDrivError('E_CONFIG', formatDiagnostics(errors), { diagnostics: errors });
  for (const w of diagnostics) if (w.severity === 'warning') options.onWarning?.(w);
  const resolved = resolveConfig(input);
  try {
    Object.defineProperty(input, RESOLVED, { value: resolved, enumerable: false, configurable: true });
  } catch {
    // frozen input; skip caching
  }
  return resolved;
}

export function formatDiagnostics(diagnostics: ConfigDiagnostic[]): string {
  return `Invalid hypdriv.config:\n${diagnostics.map((d) => `  - ${d.severity}: ${d.path}: ${d.message}`).join('\n')}`;
}
