import {
  base64UrlEncode,
  digest,
  type GeoProperties,
  isRscRequest,
  normalizeUrl,
  parseCookies,
} from '@hypdriv/core';
import type { CacheKeyInput } from './types';

/** Origin of the synthetic URLs handed to the Cache API (`https://hypdriv.cache/<key>`). */
export const CACHE_KEY_ORIGIN = 'https://hypdriv.cache';

/** Request headers that distinguish RSC payload variants of a page (ADR 0007). */
export const RSC_KEY_HEADERS = ['rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-url'] as const;

/** Version of the key serialisation; bump when the material format changes so old entries miss cleanly. */
const KEY_FORMAT = 'hypdriv-key/2';

/** Geo fields that may be used as vary dimensions, in the order they are serialised. */
const GEO_FIELDS: ReadonlyArray<keyof GeoProperties & string> = [
  'city',
  'colo',
  'continent',
  'country',
  'region',
  'timezone',
];

export interface CacheKeyMaterial {
  /** The serialised, unhashed key (one dimension per line). */
  material: string;
  /** Request header names the key depends on, sorted and lowercased. */
  vary: string[];
  /** The normalised URL that went into the key. */
  normalized: URL;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Serialises every dimension of a cache key deterministically. Exported for tests and tooling
 * (`hypdriv audit cache` prints it); production code uses `buildCacheKey`.
 */
export function serializeCacheKey(input: CacheKeyInput): CacheKeyMaterial {
  const { policy, request } = input;
  const headers = request.headers;
  const normalized = normalizeUrl(input.url, {
    ignoredQuery: input.ignoredQuery,
    keepQuery: policy.keyQuery,
    // `/legal` and `/legal/` are different entries: with Next's `trailingSlash` one of them is a redirect to the
    // other, and a shared key would serve the redirect for the page (and loop).
    trailingSlash: 'preserve',
  });
  const method = request.method.toUpperCase() === 'HEAD' ? 'GET' : request.method.toUpperCase();
  const lines: string[] = [KEY_FORMAT, `${method} ${normalized.href}`];
  const vary = new Set<string>();

  for (const name of sortedUnique(policy.vary.headers.map((h) => h.toLowerCase()))) {
    vary.add(name);
    lines.push(`h ${name}=${(headers.get(name) ?? '').trim().toLowerCase()}`);
  }

  if (policy.vary.cookies.length) {
    vary.add('cookie');
    const cookies = parseCookies(headers.get('cookie'));
    for (const name of sortedUnique(policy.vary.cookies)) {
      if (name in cookies) lines.push(`c ${name}=${cookies[name]}`);
    }
  }

  if (policy.vary.geo.length) {
    const wanted = new Set<string>(policy.vary.geo);
    for (const field of GEO_FIELDS) {
      if (!wanted.has(field)) continue;
      const value = input.geo?.[field];
      lines.push(`g ${field}=${value === undefined || value === null ? '' : String(value)}`);
    }
  }

  if (policy.vary.flags.length) {
    for (const name of sortedUnique(policy.vary.flags)) {
      const value = input.flags?.[name];
      lines.push(`f ${name}=${value === undefined ? '' : String(value)}`);
    }
  }

  if (policy.vary.language) {
    vary.add('accept-language');
    lines.push(`l ${(input.locale ?? '').toLowerCase()}`);
  }

  if (policy.vary.device) {
    vary.add('sec-ch-ua-mobile');
    lines.push(`d ${(input.device ?? '').toLowerCase()}`);
  }

  if (isRscRequest(headers)) {
    for (const name of RSC_KEY_HEADERS) {
      vary.add(name);
      lines.push(`r ${name}=${headers.get(name) ?? ''}`);
    }
  }

  lines.push(`b ${input.buildId}`);
  return { material: lines.join('\n'), vary: [...vary].sort(), normalized };
}

/**
 * Builds the cache key for a request: normalised URL (lowercase host, sorted query without ignored
 * parameters, trailing slash per Next config), method (HEAD keys like GET), the policy's vary
 * dimensions, RSC markers and the build id, hashed with SHA-256 to a base64url string.
 */
export async function buildCacheKey(
  input: CacheKeyInput,
): Promise<{ key: string; vary: string[]; url: string }> {
  const { material, vary } = serializeCacheKey(input);
  const key = base64UrlEncode(await digest(material, 'SHA-256'));
  return { key, vary, url: cacheKeyUrl(key) };
}

/** Synthetic URL for a key, usable as a Cache API request. */
export function cacheKeyUrl(key: string, origin: string = CACHE_KEY_ORIGIN): string {
  return `${origin.replace(/\/+$/, '')}/${key}`;
}
