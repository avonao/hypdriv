import {
  base64UrlDecode,
  base64UrlEncode,
  HypDrivError,
  hexEncode,
  LRUCache,
  sha256Hex,
  utf8Decode,
  utf8Encode,
} from '@hypdriv/core';

const TOKEN_VERSION = 'v1';
const IV_BYTES = 12;

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new HypDrivError('E_CRYPTO', 'WebCrypto is not available in this runtime');
  return c.subtle;
}

/** Key id of a secret: first 8 hex characters of `sha256(secret)`. Identifies the key in tokens. */
export async function keyId(secret: string): Promise<string> {
  return (await sha256Hex(secret)).slice(0, 8);
}

const keyCache = new LRUCache<string, Promise<{ kid: string; key: CryptoKey }>>(64);

/** Derives the AES-256-GCM key for a secret with HKDF-SHA256 (`info = hypdriv/v1/<kid>`), cached per secret. */
export async function deriveKey(secret: string): Promise<{ kid: string; key: CryptoKey }> {
  const hit = keyCache.get(secret);
  if (hit) return hit;
  const promise = (async () => {
    if (!secret || secret.length < 16)
      throw new HypDrivError('E_CRYPTO', 'Encryption secret must be at least 16 characters (32+ recommended)');
    const kid = await keyId(secret);
    const ikm = await subtle().importKey('raw', utf8Encode(secret) as BufferSource, 'HKDF', false, ['deriveKey']);
    const key = await subtle().deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: utf8Encode('hypdriv') as BufferSource,
        info: utf8Encode(`hypdriv/${TOKEN_VERSION}/${kid}`) as BufferSource,
      },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    return { kid, key };
  })();
  keyCache.set(secret, promise);
  promise.catch(() => keyCache.delete(secret));
  return promise;
}

/**
 * Encrypts with AES-256-GCM under a key derived from `secret`. Token format:
 * `v1.<kid>.<iv base64url>.<ciphertext+tag base64url>`. `aad` binds the token to a context
 * (cookie name, user id) without being stored in it.
 */
export async function encrypt(secret: string, plaintext: string | Uint8Array, aad?: string): Promise<string> {
  const { kid, key } = await deriveKey(secret);
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const data = typeof plaintext === 'string' ? utf8Encode(plaintext) : plaintext;
  const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource };
  if (aad !== undefined) params.additionalData = utf8Encode(aad) as BufferSource;
  const ct = new Uint8Array(await subtle().encrypt(params, key, data as BufferSource));
  return `${TOKEN_VERSION}.${kid}.${base64UrlEncode(iv)}.${base64UrlEncode(ct)}`;
}

/** Parses a token without decrypting it. */
export function parseEncryptedToken(token: string): { kid: string; iv: Uint8Array; ciphertext: Uint8Array } | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;
  const [, kid, ivText, ctText] = parts as [string, string, string, string];
  if (!/^[0-9a-f]{8}$/.test(kid) || !ivText || !ctText) return null;
  try {
    const iv = base64UrlDecode(ivText);
    const ciphertext = base64UrlDecode(ctText);
    if (iv.length !== IV_BYTES || ciphertext.length < 16) return null;
    return { kid, iv, ciphertext };
  } catch {
    return null;
  }
}

/**
 * Decrypts a token produced by `encrypt`. Tries every secret whose key id matches (rotation: pass the
 * current secret first, previous ones after). Returns `null` for malformed, tampered or foreign tokens.
 */
export async function decrypt(secrets: string | string[], token: string, aad?: string): Promise<Uint8Array | null> {
  const parsed = parseEncryptedToken(token);
  if (!parsed) return null;
  const list = Array.isArray(secrets) ? secrets : [secrets];
  for (const secret of list) {
    if (!secret) continue;
    let derived: { kid: string; key: CryptoKey };
    try {
      derived = await deriveKey(secret);
    } catch {
      continue;
    }
    if (derived.kid !== parsed.kid) continue;
    try {
      const params: AesGcmParams = { name: 'AES-GCM', iv: parsed.iv as BufferSource };
      if (aad !== undefined) params.additionalData = utf8Encode(aad) as BufferSource;
      const pt = await subtle().decrypt(params, derived.key, parsed.ciphertext as BufferSource);
      return new Uint8Array(pt);
    } catch {
      // wrong key with a colliding kid, or tampered data: try the next secret
    }
  }
  return null;
}

/** `decrypt` returning UTF-8 text. */
export async function decryptToString(secrets: string | string[], token: string, aad?: string): Promise<string | null> {
  const bytes = await decrypt(secrets, token, aad);
  return bytes ? utf8Decode(bytes) : null;
}

/** Random bytes as lowercase hex (`bytes` random bytes → `2 * bytes` characters). */
export function randomHex(bytes = 32): string {
  const out = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(out);
  return hexEncode(out);
}
