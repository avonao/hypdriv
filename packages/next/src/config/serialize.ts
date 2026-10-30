import type { HypDrivConfig } from '@hypdriv/core';

/**
 * JSON-safe projection of a HypDriv config: RegExp values become `{ "$regex": source, "$flags": flags }`,
 * functions are dropped (they cannot cross the process boundary between next.config and the adapter).
 */
export function serializeConfig(config: HypDrivConfig): string {
  return JSON.stringify(config, (_key, value: unknown) => {
    if (value instanceof RegExp) return { $regex: value.source, $flags: value.flags };
    if (typeof value === 'function') return undefined;
    return value;
  });
}

export function reviveConfig(json: string): HypDrivConfig {
  return JSON.parse(json, (_key, value: unknown) => {
    if (value && typeof value === 'object' && '$regex' in (value as Record<string, unknown>)) {
      const v = value as { $regex: string; $flags?: string };
      return new RegExp(v.$regex, v.$flags ?? '');
    }
    return value;
  }) as HypDrivConfig;
}

export const ADAPTER_CONFIG_FILE = '.hypdriv/adapter-config.json';
export const BASE_ADAPTER_ENV = 'HYPDRIV_BASE_ADAPTER';
export const PROJECT_DIR_ENV = 'HYPDRIV_PROJECT_DIR';
