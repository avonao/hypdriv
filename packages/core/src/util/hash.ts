import { base64Encode, base64UrlEncode, hexEncode, utf8Encode } from './encoding';

export type HashAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512' | 'SHA-1';

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available in this runtime');
  return c.subtle;
}

export async function digest(
  input: string | Uint8Array | ArrayBuffer,
  algorithm: HashAlgorithm = 'SHA-256',
): Promise<Uint8Array> {
  const data = typeof input === 'string' ? utf8Encode(input) : input;
  const buf = await subtle().digest(algorithm, data as BufferSource);
  return new Uint8Array(buf);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  return hexEncode(await digest(input, 'SHA-256'));
}

export async function sha256Base64(input: string | Uint8Array): Promise<string> {
  return base64Encode(await digest(input, 'SHA-256'));
}

export async function sha256Base64Url(input: string | Uint8Array): Promise<string> {
  return base64UrlEncode(await digest(input, 'SHA-256'));
}

/** CSP hash source, e.g. `'sha256-abc...='`. */
export async function cspHash(
  content: string,
  algorithm: 'sha256' | 'sha384' | 'sha512' = 'sha256',
): Promise<string> {
  const algo: HashAlgorithm =
    algorithm === 'sha256' ? 'SHA-256' : algorithm === 'sha384' ? 'SHA-384' : 'SHA-512';
  return `'${algorithm}-${base64Encode(await digest(content, algo))}'`;
}

/** SRI integrity attribute value, e.g. `sha384-...`. */
export async function sriHash(
  content: string | Uint8Array,
  algorithm: 'sha256' | 'sha384' | 'sha512' = 'sha384',
): Promise<string> {
  const algo: HashAlgorithm =
    algorithm === 'sha256' ? 'SHA-256' : algorithm === 'sha384' ? 'SHA-384' : 'SHA-512';
  return `${algorithm}-${base64Encode(await digest(content, algo))}`;
}

export async function hmacSign(
  secret: string | Uint8Array,
  data: string | Uint8Array,
  algorithm: HashAlgorithm = 'SHA-256',
): Promise<Uint8Array> {
  const key = await subtle().importKey(
    'raw',
    (typeof secret === 'string' ? utf8Encode(secret) : secret) as BufferSource,
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  const sig = await subtle().sign(
    'HMAC',
    key,
    (typeof data === 'string' ? utf8Encode(data) : data) as BufferSource,
  );
  return new Uint8Array(sig);
}

export async function hmacVerify(
  secret: string | Uint8Array,
  data: string | Uint8Array,
  signature: Uint8Array,
  algorithm: HashAlgorithm = 'SHA-256',
): Promise<boolean> {
  const key = await subtle().importKey(
    'raw',
    (typeof secret === 'string' ? utf8Encode(secret) : secret) as BufferSource,
    { name: 'HMAC', hash: algorithm },
    false,
    ['verify'],
  );
  return subtle().verify(
    'HMAC',
    key,
    signature as BufferSource,
    (typeof data === 'string' ? utf8Encode(data) : data) as BufferSource,
  );
}

/**
 * cyrb53: a fast, well-distributed 53-bit non-cryptographic hash. Synchronous; used for cache keys,
 * bucketing and ids where WebCrypto's async API would be awkward.
 */
export function cyrb53(input: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** cyrb53 as a short base36 string (up to 11 chars). */
export function shortHash(input: string, seed = 0): string {
  return cyrb53(input, seed).toString(36);
}

/** FNV-1a 32-bit, for very hot paths. */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic bucket in [0, 100) for percentage rollouts. */
export function bucketPercent(key: string, salt = ''): number {
  return (cyrb53(`${salt}:${key}`) % 10000) / 100;
}
