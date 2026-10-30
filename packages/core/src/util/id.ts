import { base64UrlEncode } from './encoding';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Random base64url token of `bytes` random bytes (default 16 → 22 chars). */
export function randomToken(bytes = 16): string {
  return base64UrlEncode(randomBytes(bytes));
}

/** CSP nonce: 128 bits, base64 (CSP requires base64 characters; url-safe is also accepted). */
export function createNonce(): string {
  return base64UrlEncode(randomBytes(16));
}

/**
 * Time-ordered unique id (UUIDv7 layout): 48-bit ms timestamp, version 7, 74 random bits.
 * Sorts by creation time, which makes logs and traces easy to correlate.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Request id: short, time-ordered, URL-safe. */
export function createRequestId(): string {
  return uuidv7();
}

/** 16-byte trace id / 8-byte span id as lowercase hex (W3C Trace Context). */
export function createTraceId(): string {
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createSpanId(): string {
  return Array.from(randomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
}
