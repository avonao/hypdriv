import {
  base64UrlDecode,
  base64UrlEncode,
  type FlagValue,
  HEADER,
  stableStringify,
  utf8Decode,
} from '@hypdriv/core';

/** `true` for the three value types a flag may hold (`NaN`/`Infinity` are rejected). */
export function isFlagValue(value: unknown): value is FlagValue {
  return (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Keeps only entries whose values are valid flag values. */
export function sanitizeFlagValues(input: unknown): Record<string, FlagValue> {
  const out: Record<string, FlagValue> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (isFlagValue(value)) out[name] = value;
  }
  return out;
}

/**
 * Encodes evaluated flags for transport in a request header (`x-hypdriv-flags`) or in the
 * `<meta name="hypdriv:flags">` tag the DevTools HUD reads: base64url of a JSON object with sorted
 * keys, so identical flag sets always produce identical strings (cache keys can use it directly).
 */
export function encodeFlagsHeader(values: Record<string, FlagValue>): string {
  return base64UrlEncode(stableStringify(sanitizeFlagValues(values)));
}

/**
 * Decodes a value produced by {@link encodeFlagsHeader}. Tolerant: `null`, empty strings, raw JSON
 * objects (`{"a":true}`), standard base64 and invalid input all decode without throwing (invalid
 * input yields `{}`), and entries with non-flag values are dropped.
 */
export function decodeFlagsHeader(value: string | null | undefined): Record<string, FlagValue> {
  if (!value) return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) return parseJsonObject(trimmed);
  let text: string;
  try {
    text = utf8Decode(base64UrlDecode(trimmed));
  } catch {
    return {};
  }
  return parseJsonObject(text);
}

/** Reads and decodes the flags header forwarded by the `flags` stage (default `x-hypdriv-flags`). */
export function flagsFromHeaders(
  headers: Headers,
  headerName: string = HEADER.flags,
): Record<string, FlagValue> {
  return decodeFlagsHeader(headers.get(headerName));
}

function parseJsonObject(text: string): Record<string, FlagValue> {
  try {
    return sanitizeFlagValues(JSON.parse(text));
  } catch {
    return {};
  }
}
