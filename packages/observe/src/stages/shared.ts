import { HEADER, type HypContext, type StateKey, stateKey } from '@hypdriv/core';
import type { Span } from '../trace/span';

/** Trace identifiers of the current request (contracts.md shared state keys). */
export const TRACE_KEY: StateKey<{ traceId: string; spanId: string; sampled: boolean }> = stateKey('trace');

/** The root `http.request` span when a tracer is configured; stages may add events or child spans. */
export const ROOT_SPAN_KEY: StateKey<Span> = stateKey('trace.span');

/**
 * Cache outcome of the request: the `x-hypdriv-cache` response header when the cache stage emits
 * it, else the `cache` Server-Timing marker it always records (no import of `@hypdriv/cache` needed).
 */
export function cacheStatusOf(ctx: HypContext, response?: Response): string | undefined {
  const header = response?.headers.get(HEADER.cache) ?? ctx.responseHeaders.get(HEADER.cache);
  if (header) return header;
  let marker: string | undefined;
  for (const entry of ctx.timings.list()) if (entry.name === 'cache' && entry.desc) marker = entry.desc;
  return marker;
}

/** Masks the last IPv4 octet / the interface half of an IPv6 address for request logs. */
export function maskIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  if (ip.includes(':')) {
    const groups = ip.split(':');
    return `${groups.slice(0, 4).join(':')}::`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  return `${parts.slice(0, 3).join('.')}.0`;
}
