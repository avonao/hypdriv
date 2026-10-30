import { shortHash } from '@hypdriv/core';

/** Vercel CDN limit: UTF-8 bytes per cache tag (quotes and backslashes count at their escaped length). */
export const MAX_TAG_BYTES = 256;
/** Vercel CDN limit: tags per cached response. */
export const MAX_TAGS_PER_RESPONSE = 128;
/** Vercel limit: tags per purge call. */
export const MAX_TAGS_PER_PURGE = 16;

/** Prefix of the per-path tag HypDriv adds to every CDN-cached response (`hyp:path:/blog/hello`). */
export const PATH_TAG_PREFIX = 'hyp:path:';
/** Prefix of the per-route tag HypDriv adds to every CDN-cached response (`hyp:route:app:/blog/[slug]`). */
export const ROUTE_TAG_PREFIX = 'hyp:route:';

function escapedLength(tag: string): number {
  let n = tag.length;
  for (const ch of tag) if (ch === '"' || ch === '\\') n++;
  return n;
}

function encodeChar(ch: string): string {
  try {
    return encodeURIComponent(ch);
  } catch {
    // Lone surrogate: not representable in UTF-8.
    return '%EF%BF%BD';
  }
}

/**
 * Makes a string usable as a Vercel cache tag, deterministically, so the CDN stage and the purger always
 * agree: trims, percent-encodes commas (the list delimiter), whitespace, control and non-ASCII characters
 * (response header values must be ASCII), and shortens tags over 256 escaped bytes to a prefix plus a hash.
 * Returns `null` for empty input.
 */
export function sanitizeTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let out = '';
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0;
    out += ch === ',' || code <= 0x20 || code >= 0x7f ? encodeChar(ch) : ch;
  }
  if (escapedLength(out) <= MAX_TAG_BYTES) return out;
  const suffix = `~${shortHash(trimmed)}${shortHash(trimmed, 1)}`;
  let prefix = out.slice(0, MAX_TAG_BYTES - suffix.length);
  // Do not cut a percent-escape in half, and stay within the escaped-length budget.
  prefix = prefix.replace(/%[0-9A-F]?$/i, '');
  while (escapedLength(prefix) + suffix.length > MAX_TAG_BYTES) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}

/** Sanitises and de-duplicates tags, preserving order; optionally caps the count. */
export function sanitizeTags(tags: Iterable<string>, max = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = sanitizeTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** The per-path tag for a pathname (`hyp:path:/blog/hello`). */
export function pathTag(pathname: string): string {
  return `${PATH_TAG_PREFIX}${pathname || '/'}`;
}

/** The per-route tag for a manifest route id (`hyp:route:app:/blog/[slug]`). */
export function routeTag(routeId: string): string {
  return `${ROUTE_TAG_PREFIX}${routeId}`;
}
