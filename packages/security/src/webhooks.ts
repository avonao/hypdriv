import { base64Decode, base64Encode, hexEncode, hmacSign, timingSafeEqual, utf8Encode } from '@hypdriv/core';

const DEFAULT_TOLERANCE = 300;

function withinTolerance(timestampSeconds: number, toleranceSeconds: number, now: number): boolean {
  if (!Number.isFinite(timestampSeconds)) return false;
  return Math.abs(now / 1000 - timestampSeconds) <= toleranceSeconds;
}

/**
 * Verifies a Stripe `Stripe-Signature` header (`t=<ts>,v1=<hex>[,v1=…]`): HMAC-SHA256 over
 * `"<t>.<payload>"` with the endpoint secret (`whsec_…`), within `toleranceSeconds` (default 300).
 * `payload` must be the raw request body, not re-serialised JSON.
 */
export async function verifyStripe(
  payload: string,
  header: string,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE,
  now: number = Date.now(),
): Promise<boolean> {
  if (!payload || !header || !secret) return false;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1') signatures.push(v);
  }
  if (!timestamp || !signatures.length) return false;
  if (!withinTolerance(Number(timestamp), toleranceSeconds, now)) return false;
  const expected = hexEncode(await hmacSign(secret, `${timestamp}.${payload}`));
  let ok = false;
  for (const sig of signatures) if (timingSafeEqual(expected, sig.toLowerCase())) ok = true;
  return ok;
}

/** Verifies GitHub's `X-Hub-Signature-256` (`sha256=<hex>`) over the raw body. */
export async function verifyGitHub(payload: string, signature256: string, secret: string): Promise<boolean> {
  if (!payload || !signature256 || !secret) return false;
  const sig = signature256.startsWith('sha256=') ? signature256.slice(7) : signature256;
  const expected = hexEncode(await hmacSign(secret, payload));
  return timingSafeEqual(expected, sig.trim().toLowerCase());
}

/** Decodes a Standard Webhooks secret (`whsec_<base64>`, or a raw string). */
export function standardWebhookKey(secret: string): Uint8Array {
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  try {
    return base64Decode(raw);
  } catch {
    return utf8Encode(raw);
  }
}

/**
 * Verifies a Standard Webhooks (Svix-compatible) signature: HMAC-SHA256 over `"<id>.<timestamp>.<payload>"`
 * with the base64 secret, compared against every `v1,<base64>` entry of `webhook-signature`, within
 * `toleranceSeconds` of `webhook-timestamp` (seconds).
 */
export async function verifyStandard(
  payload: string,
  headers: { id: string; timestamp: string; signature: string },
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE,
  now: number = Date.now(),
): Promise<boolean> {
  if (!payload || !headers.id || !headers.timestamp || !headers.signature || !secret) return false;
  if (!/^\d+$/.test(headers.timestamp) || !withinTolerance(Number(headers.timestamp), toleranceSeconds, now))
    return false;
  const expected = base64Encode(
    await hmacSign(standardWebhookKey(secret), `${headers.id}.${headers.timestamp}.${payload}`),
  );
  let ok = false;
  for (const entry of headers.signature.split(/\s+/)) {
    const [version, sig] = entry.split(',');
    if (version !== 'v1' || !sig) continue;
    if (timingSafeEqual(expected, sig)) ok = true;
  }
  return ok;
}

/** Reads the Standard Webhooks headers from a request. */
export function standardWebhookHeaders(headers: Headers): {
  id: string;
  timestamp: string;
  signature: string;
} {
  return {
    id: headers.get('webhook-id') ?? headers.get('svix-id') ?? '',
    timestamp: headers.get('webhook-timestamp') ?? headers.get('svix-timestamp') ?? '',
    signature: headers.get('webhook-signature') ?? headers.get('svix-signature') ?? '',
  };
}

/** Webhook verification namespace (matches the `webhooks` export in docs/contracts.md). */
export const webhooks = {
  verifyStripe,
  verifyGitHub,
  verifyStandard,
  standardWebhookHeaders,
  standardWebhookKey,
};
