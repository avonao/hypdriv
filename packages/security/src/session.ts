import { COOKIE, expireCookie, getCookie, HypDrivError, serializeCookie } from '@hypdriv/core';
import { decryptToString, encrypt } from './crypto';

/** Options of `createSessionStore`. */
export interface SessionStoreOptions {
  /** Current secret first; previous secrets after it keep old cookies readable during rotation. */
  secret: string | string[];
  /** Cookie name (default `hyp_session`). */
  cookie?: string;
  /** Lifetime in seconds (default 7 days). */
  ttlSeconds?: number;
  /** Report `needsRefresh` once more than half of the TTL elapsed (default true). */
  sliding?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  /** Default true; `false` only for local http testing. */
  secure?: boolean;
  path?: string;
  domain?: string;
  /** Clock override (epoch ms). */
  now?: () => number;
}

/** Result of `SessionStore.read`. */
export interface SessionReadResult<T> {
  data: T | null;
  /** Epoch milliseconds, or null when there is no valid session. */
  expiresAt: number | null;
  /** `true` when the session should be re-written to extend it (sliding expiry). */
  needsRefresh: boolean;
  /** Which secret decrypted the cookie: `current` or `previous` (rotation in progress). */
  key?: 'current' | 'previous';
}

/** Encrypted cookie session store. */
export interface SessionStore<T> {
  readonly cookieName: string;
  read(headers: Headers): Promise<SessionReadResult<T>>;
  /** Encrypts `data` and returns the `Set-Cookie` header value. */
  write(data: T, options?: { ttlSeconds?: number }): Promise<string>;
  /** `Set-Cookie` value that deletes the session cookie. */
  clear(): string;
  /** Encrypts without cookie attributes (for storing the token elsewhere). */
  seal(data: T, options?: { ttlSeconds?: number }): Promise<string>;
  /** Decrypts a raw token produced by `seal`/`write`. */
  unseal(token: string): Promise<SessionReadResult<T>>;
}

/** Browsers reject cookies above ~4 KiB; stay below with margin for the attributes. */
export const MAX_SESSION_COOKIE_BYTES = 4000;

interface Envelope<T> {
  data: T;
  iat: number;
  exp: number;
}

/**
 * Creates an AES-256-GCM encrypted cookie session (HKDF-derived, versioned keys; see `encrypt`).
 * The cookie name is bound into the ciphertext as additional authenticated data, so a token cannot be
 * replayed under a different cookie.
 */
export function createSessionStore<T extends object>(options: SessionStoreOptions): SessionStore<T> {
  const secrets = (Array.isArray(options.secret) ? options.secret : [options.secret]).filter(Boolean);
  if (!secrets.length)
    throw new HypDrivError('E_CRYPTO', 'createSessionStore: at least one secret is required');
  const current = secrets[0]!;
  const name = options.cookie ?? COOKIE.session;
  const ttl = options.ttlSeconds ?? 7 * 86400;
  const sliding = options.sliding ?? true;
  const now = options.now ?? (() => Date.now());
  const attrs = {
    path: options.path ?? '/',
    sameSite: options.sameSite ?? 'lax',
    secure: options.secure ?? true,
    ...(options.domain ? { domain: options.domain } : {}),
  } as const;
  const aad = `session:${name}`;

  const seal = async (data: T, o: { ttlSeconds?: number } = {}): Promise<string> => {
    const iat = Math.floor(now() / 1000);
    const envelope: Envelope<T> = { data, iat, exp: iat + (o.ttlSeconds ?? ttl) };
    return encrypt(current, JSON.stringify(envelope), aad);
  };

  const unseal = async (token: string): Promise<SessionReadResult<T>> => {
    const empty: SessionReadResult<T> = { data: null, expiresAt: null, needsRefresh: false };
    if (!token) return empty;
    // Try the current secret first so `key` reports whether rotation is still in progress.
    let text = await decryptToString(current, token, aad);
    let key: 'current' | 'previous' = 'current';
    if (text === null && secrets.length > 1) {
      text = await decryptToString(secrets.slice(1), token, aad);
      key = 'previous';
    }
    if (text === null) return empty;
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      return empty;
    }
    if (!envelope || typeof envelope !== 'object' || typeof envelope.exp !== 'number') return empty;
    const nowSeconds = now() / 1000;
    if (envelope.exp <= nowSeconds) return empty;
    const lifetime = envelope.exp - envelope.iat;
    const elapsed = nowSeconds - envelope.iat;
    const needsRefresh = key === 'previous' || (sliding && lifetime > 0 && elapsed > lifetime / 2);
    return { data: envelope.data, expiresAt: envelope.exp * 1000, needsRefresh, key };
  };

  return {
    cookieName: name,
    seal,
    unseal,
    async read(headers) {
      return unseal(getCookie(headers, name) ?? '');
    },
    async write(data, o = {}) {
      const token = await seal(data, o);
      const cookie = serializeCookie(name, token, { ...attrs, httpOnly: true, maxAge: o.ttlSeconds ?? ttl });
      if (cookie.length > MAX_SESSION_COOKIE_BYTES)
        throw new HypDrivError(
          'E_CRYPTO',
          `Session cookie "${name}" is ${cookie.length} bytes; browsers drop cookies above ~4 KiB. Store less in the session (an id, a role, a few flags) and keep the rest server-side.`,
          { bytes: cookie.length, limit: MAX_SESSION_COOKIE_BYTES },
        );
      return cookie;
    },
    clear() {
      return expireCookie(name, attrs);
    },
  };
}
