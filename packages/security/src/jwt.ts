import {
  base64Decode,
  base64UrlDecode,
  base64UrlEncode,
  HypDrivError,
  utf8Decode,
  utf8Encode,
} from '@hypdriv/core';

/** Supported JWS algorithms. */
export type JwtAlgorithm = 'HS256' | 'ES256' | 'RS256';
export const JWT_ALGORITHMS: ReadonlyArray<JwtAlgorithm> = ['HS256', 'ES256', 'RS256'];

/** Machine-readable verification failure reasons. */
export type JwtErrorReason =
  | 'malformed'
  | 'alg-none'
  | 'alg-not-allowed'
  | 'key-mismatch'
  | 'unsupported-key'
  | 'unknown-kid'
  | 'jwks-fetch-failed'
  | 'invalid-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'issued-in-future'
  | 'too-old'
  | 'issuer'
  | 'audience'
  | 'subject';

/** Thrown by `jwt.verify` (and `jwt.sign` for key problems); `status` is 401. */
export class JwtError extends HypDrivError {
  readonly reason: JwtErrorReason;
  constructor(reason: JwtErrorReason, message: string) {
    super('E_UNAUTHORIZED', message, { reason }, { status: 401 });
    this.name = 'JwtError';
    this.reason = reason;
  }
}

/** Options of `jwt.sign`. */
export interface JwtSignOptions {
  alg: JwtAlgorithm;
  /** Lifetime in seconds (`exp = iat + expiresIn`). */
  expiresIn?: number;
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  /** `nbf` offset in seconds from now. */
  notBefore?: number;
  kid?: string;
  /** Extra protected header members. */
  header?: Record<string, unknown>;
  /** Clock override (epoch ms). */
  now?: number;
}

/** Options of `jwt.verify`. */
export interface JwtVerifyOptions {
  /** Allowed algorithms (default: all three, further restricted by the key type). */
  algorithms?: string[];
  issuer?: string | string[];
  audience?: string | string[];
  subject?: string;
  /** Seconds of leeway for `exp`/`nbf`/`iat` (default 0). */
  clockTolerance?: number;
  /** Reject tokens whose `iat` is older than this many seconds. */
  maxTokenAge?: number;
  fetch?: typeof fetch;
  /** Clock override (epoch ms). */
  now?: number;
}

/** A JWK with the identification members the DOM type omits. */
export type Jwk = JsonWebKey & { kid?: string; use?: string; alg?: string; crv?: string; kty?: string };

/** Key material accepted by `jwt.verify`. */
export type JwtVerifyKey = string | CryptoKey | { jwksUrl: string } | Jwk[];

export interface JwtDecoded {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

const ALG_PARAMS: Record<
  JwtAlgorithm,
  {
    import: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams;
    sign: AlgorithmIdentifier | EcdsaParams;
  }
> = {
  HS256: { import: { name: 'HMAC', hash: 'SHA-256' }, sign: { name: 'HMAC' } },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
};

function algForCryptoKey(key: CryptoKey): JwtAlgorithm | null {
  const name = key.algorithm.name;
  if (name === 'HMAC') return 'HS256';
  if (name === 'ECDSA') return 'ES256';
  if (name === 'RSASSA-PKCS1-v1_5') return 'RS256';
  return null;
}

function isPem(text: string): boolean {
  return /-----BEGIN [A-Z ]+-----/.test(text);
}

function pemBody(pem: string): { label: string; der: Uint8Array } {
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (!m) throw new JwtError('unsupported-key', 'Malformed PEM');
  return { label: m[1]!, der: base64Decode((m[2] ?? '').replace(/\s+/g, '')) };
}

/** Imports a PEM key (SPKI public or PKCS#8 private) for an algorithm. */
export async function importPemKey(
  pem: string,
  alg: JwtAlgorithm,
  usage: 'sign' | 'verify',
): Promise<CryptoKey> {
  const { label, der } = pemBody(pem);
  if (label === 'RSA PRIVATE KEY' || label === 'EC PRIVATE KEY')
    throw new JwtError(
      'unsupported-key',
      `${label} (PKCS#1/SEC1) is not supported by WebCrypto; convert it to PKCS#8 (\`openssl pkcs8 -topk8 -nocrypt\`)`,
    );
  if (label === 'CERTIFICATE')
    throw new JwtError(
      'unsupported-key',
      'X.509 certificates are not supported; extract the public key (`openssl x509 -pubkey -noout`)',
    );
  const format = label === 'PRIVATE KEY' ? 'pkcs8' : label === 'PUBLIC KEY' ? 'spki' : null;
  if (!format) throw new JwtError('unsupported-key', `Unsupported PEM label "${label}"`);
  if (format === 'spki' && usage === 'sign')
    throw new JwtError('unsupported-key', 'Signing requires a private key');
  if (alg === 'HS256') throw new JwtError('key-mismatch', 'HS256 uses a shared secret, not a PEM key');
  try {
    return await crypto.subtle.importKey(format, der as BufferSource, ALG_PARAMS[alg].import, false, [usage]);
  } catch (error) {
    throw new JwtError('unsupported-key', `Cannot import PEM key for ${alg}: ${(error as Error).message}`);
  }
}

/** Imports a JWK for verification, deriving the algorithm from `kty` when `alg` is absent. */
export async function importJwk(jwk: Jwk, alg: JwtAlgorithm): Promise<CryptoKey> {
  const expected =
    jwk.kty === 'oct' ? 'HS256' : jwk.kty === 'EC' ? 'ES256' : jwk.kty === 'RSA' ? 'RS256' : null;
  if (expected !== alg)
    throw new JwtError('key-mismatch', `JWK key type ${String(jwk.kty)} does not match ${alg}`);
  if (jwk.alg && jwk.alg !== alg)
    throw new JwtError('key-mismatch', `JWK alg ${jwk.alg} does not match ${alg}`);
  if (alg === 'ES256' && jwk.crv && jwk.crv !== 'P-256')
    throw new JwtError('key-mismatch', `JWK curve ${jwk.crv} is not P-256`);
  const { key_ops: _ops, ...rest } = jwk;
  try {
    return await crypto.subtle.importKey('jwk', rest, ALG_PARAMS[alg].import, false, ['verify']);
  } catch (error) {
    throw new JwtError('unsupported-key', `Cannot import JWK: ${(error as Error).message}`);
  }
}

async function secretKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', utf8Encode(secret) as BufferSource, ALG_PARAMS.HS256.import, false, [
    usage,
  ]);
}

function encodeSegment(value: unknown): string {
  return base64UrlEncode(utf8Encode(JSON.stringify(value)));
}

/** Decodes header and payload without verifying. Returns null for malformed tokens. */
export function decode(token: string): JwtDecoded | null {
  if (typeof token !== 'string' || token.length > 65536) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(utf8Decode(base64UrlDecode(parts[0]!))) as unknown;
    const payload = JSON.parse(utf8Decode(base64UrlDecode(parts[1]!))) as unknown;
    if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return { header: header as Record<string, unknown>, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Signs a compact JWS. `key` is a shared secret (HS256), a PKCS#8 PEM string or a private `CryptoKey`. */
export async function sign(
  payload: object,
  key: string | CryptoKey,
  options: JwtSignOptions,
): Promise<string> {
  const alg = options.alg;
  if (!JWT_ALGORITHMS.includes(alg))
    throw new JwtError('alg-not-allowed', `Unsupported algorithm ${String(alg)}`);
  let cryptoKey: CryptoKey;
  if (typeof key === 'string') {
    if (alg === 'HS256') {
      if (isPem(key)) throw new JwtError('key-mismatch', 'HS256 needs a shared secret, not a PEM key');
      if (key.length < 32)
        throw new JwtError('unsupported-key', 'HS256 secrets must be at least 32 characters (256 bits)');
      cryptoKey = await secretKey(key, 'sign');
    } else cryptoKey = await importPemKey(key, alg, 'sign');
  } else {
    const keyAlg = algForCryptoKey(key);
    if (keyAlg !== alg)
      throw new JwtError('key-mismatch', `CryptoKey algorithm ${key.algorithm.name} does not match ${alg}`);
    cryptoKey = key;
  }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const claims: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  if (claims.iat === undefined) claims.iat = nowSeconds;
  if (options.expiresIn !== undefined) claims.exp = nowSeconds + options.expiresIn;
  if (options.notBefore !== undefined) claims.nbf = nowSeconds + options.notBefore;
  if (options.issuer !== undefined) claims.iss = options.issuer;
  if (options.audience !== undefined) claims.aud = options.audience;
  if (options.subject !== undefined) claims.sub = options.subject;
  const header: Record<string, unknown> = { ...(options.header ?? {}), alg, typ: 'JWT' };
  if (options.kid) header.kid = options.kid;
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const signature = await crypto.subtle.sign(
    ALG_PARAMS[alg].sign,
    cryptoKey,
    utf8Encode(signingInput) as BufferSource,
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

interface JwksCacheEntry {
  keys: Jwk[];
  fetchedAt: number;
}
const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<string, JwksCacheEntry>();

async function fetchJwks(url: string, fetchImpl: typeof fetch, now: number): Promise<Jwk[]> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new JwtError('jwks-fetch-failed', `JWKS fetch failed: ${(error as Error).message}`);
  }
  if (!res.ok) throw new JwtError('jwks-fetch-failed', `JWKS fetch failed with HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new JwtError('jwks-fetch-failed', 'JWKS response has no `keys` array');
  const keys = body.keys.filter((k): k is Jwk => !!k && typeof k === 'object');
  jwksCache.set(url, { keys, fetchedAt: now });
  return keys;
}

/** Returns cached JWKS keys (10 minute TTL), fetching when stale or absent. */
export async function getJwks(
  url: string,
  options: { fetch?: typeof fetch; now?: number; force?: boolean } = {},
): Promise<Jwk[]> {
  const now = options.now ?? Date.now();
  const hit = jwksCache.get(url);
  if (!options.force && hit && now - hit.fetchedAt < JWKS_TTL_MS) return hit.keys;
  return fetchJwks(url, options.fetch ?? globalThis.fetch, now);
}

/** For tests: clears the JWKS cache. */
export function clearJwksCache(): void {
  jwksCache.clear();
}

function pickJwk(keys: Jwk[], kid: unknown, alg: JwtAlgorithm): Jwk | undefined {
  const kty = alg === 'HS256' ? 'oct' : alg === 'ES256' ? 'EC' : 'RSA';
  const candidates = keys.filter(
    (k) => k.kty === kty && (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg),
  );
  if (typeof kid === 'string') return candidates.find((k) => k.kid === kid);
  return candidates.length === 1 ? candidates[0] : undefined;
}

async function resolveVerifyKey(
  keyInput: JwtVerifyKey,
  alg: JwtAlgorithm,
  kid: unknown,
  options: JwtVerifyOptions,
): Promise<CryptoKey> {
  if (typeof keyInput === 'string') {
    if (isPem(keyInput)) return importPemKey(keyInput, alg, 'verify');
    if (alg !== 'HS256')
      throw new JwtError('key-mismatch', `A shared secret can only verify HS256 tokens, not ${alg}`);
    return secretKey(keyInput, 'verify');
  }
  if (
    keyInput instanceof CryptoKey ||
    (typeof keyInput === 'object' && 'algorithm' in keyInput && 'type' in keyInput)
  ) {
    const ck = keyInput as CryptoKey;
    if (algForCryptoKey(ck) !== alg)
      throw new JwtError('key-mismatch', `CryptoKey algorithm ${ck.algorithm.name} does not match ${alg}`);
    return ck;
  }
  if (Array.isArray(keyInput)) {
    const jwk = pickJwk(keyInput, kid, alg);
    if (!jwk) throw new JwtError('unknown-kid', 'No JWK matches the token (kid/alg)');
    return importJwk(jwk, alg);
  }
  const now = options.now ?? Date.now();
  const cached = jwksCache.get(keyInput.jwksUrl);
  let keys = await getJwks(keyInput.jwksUrl, { fetch: options.fetch, now });
  let jwk = pickJwk(keys, kid, alg);
  if (!jwk && cached) {
    // Unknown kid with a cached set: the issuer may have rotated keys; refetch once.
    keys = await getJwks(keyInput.jwksUrl, { fetch: options.fetch, now, force: true });
    jwk = pickJwk(keys, kid, alg);
  }
  if (!jwk) throw new JwtError('unknown-kid', 'No JWK in the JWKS matches the token (kid/alg)');
  return importJwk(jwk, alg);
}

function matches(claim: unknown, expected: string | string[] | undefined): boolean {
  if (expected === undefined) return true;
  const wanted = Array.isArray(expected) ? expected : [expected];
  const have = Array.isArray(claim) ? claim : [claim];
  return have.some((v) => typeof v === 'string' && wanted.includes(v));
}

/**
 * Verifies a compact JWS and its standard claims. Rejects `alg: none`, algorithms outside the allow-list
 * and key/algorithm confusion (a shared secret never verifies RS/ES tokens). JWKS sets are cached for
 * 10 minutes and refetched once on an unknown `kid`.
 */
export async function verify(
  token: string,
  keyOrJwks: JwtVerifyKey,
  options: JwtVerifyOptions = {},
): Promise<JwtDecoded> {
  const decoded = decode(token);
  if (!decoded) throw new JwtError('malformed', 'Malformed JWT');
  const algRaw = decoded.header.alg;
  if (typeof algRaw !== 'string' || algRaw.toLowerCase() === 'none')
    throw new JwtError('alg-none', 'Unsigned tokens are rejected');
  const allowed = (options.algorithms ?? JWT_ALGORITHMS).map((a) => a.toUpperCase());
  if (!allowed.includes(algRaw) || !JWT_ALGORITHMS.includes(algRaw as JwtAlgorithm))
    throw new JwtError('alg-not-allowed', `Algorithm ${algRaw} is not allowed`);
  const alg = algRaw as JwtAlgorithm;
  const key = await resolveVerifyKey(keyOrJwks, alg, decoded.header.kid, options);

  const [h, p, s] = token.split('.') as [string, string, string];
  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(s);
  } catch {
    throw new JwtError('malformed', 'Malformed signature');
  }
  if (alg === 'ES256' && signature.length !== 64)
    throw new JwtError('invalid-signature', 'ES256 signatures must be 64 raw bytes');
  const ok = await crypto.subtle.verify(
    ALG_PARAMS[alg].sign,
    key,
    signature as BufferSource,
    utf8Encode(`${h}.${p}`) as BufferSource,
  );
  if (!ok) throw new JwtError('invalid-signature', 'Invalid signature');

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const tol = options.clockTolerance ?? 0;
  const { exp, nbf, iat, iss, aud, sub } = decoded.payload;
  if (exp !== undefined && (typeof exp !== 'number' || now > exp + tol))
    throw new JwtError('expired', 'Token expired');
  if (nbf !== undefined && (typeof nbf !== 'number' || now + tol < nbf))
    throw new JwtError('not-yet-valid', 'Token not yet valid');
  if (iat !== undefined && (typeof iat !== 'number' || iat > now + tol))
    throw new JwtError('issued-in-future', 'Token issued in the future');
  if (options.maxTokenAge !== undefined) {
    if (typeof iat !== 'number' || now - iat > options.maxTokenAge + tol)
      throw new JwtError('too-old', 'Token is too old');
  }
  if (!matches(iss, options.issuer)) throw new JwtError('issuer', 'Unexpected issuer');
  if (options.audience !== undefined && !matches(aud, options.audience))
    throw new JwtError('audience', 'Unexpected audience');
  if (options.subject !== undefined && sub !== options.subject)
    throw new JwtError('subject', 'Unexpected subject');
  return decoded;
}

/** JWT namespace (matches the `jwt` export in docs/contracts.md). */
export const jwt = { sign, verify, decode, getJwks, clearJwksCache, importPemKey, importJwk };
