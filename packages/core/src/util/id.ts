import { base64UrlEncode } from './encoding';

/**
 * A request needs several random values (its id, a nonce, a trace id, a span id), and a call into the platform's
 * generator costs far more than the bytes it returns: on Node every call is a system call. So the bytes come from a
 * pool that is filled a kilobyte at a time. A byte is handed out once and then cleared.
 *
 * The pool is filled on first use, never when the module loads: Workers allow no randomness in the global scope.
 */
const POOL_SIZE = 1024;
let pool: Uint8Array<ArrayBuffer> | null = null;
let used = POOL_SIZE;

function randomBytes(length: number): Uint8Array {
  if (length > POOL_SIZE / 4) {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  if (pool === null || used + length > POOL_SIZE) {
    pool ??= new Uint8Array(POOL_SIZE);
    globalThis.crypto.getRandomValues(pool);
    used = 0;
  }
  const bytes = pool.slice(used, used + length);
  pool.fill(0, used, used + length);
  used += length;
  return bytes;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b];
  return out;
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
  // 48 bits of milliseconds, high byte first (a number holds them exactly; bit operators would cut them to 32)
  let ts = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Request id: short, time-ordered, URL-safe. */
export function createRequestId(): string {
  return uuidv7();
}

/** 16-byte trace id / 8-byte span id as lowercase hex (W3C Trace Context). */
export function createTraceId(): string {
  return hex(randomBytes(16));
}

export function createSpanId(): string {
  return hex(randomBytes(8));
}
