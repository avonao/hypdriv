export interface CookieAttributes {
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'lax' | 'strict' | 'none' | 'Lax' | 'Strict' | 'None';
  partitioned?: boolean;
  priority?: 'low' | 'medium' | 'high';
}

/** Parses a `Cookie` request header into a map (first occurrence wins, like browsers send them). */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function getCookie(headers: Headers, name: string): string | undefined {
  return parseCookies(headers.get('cookie'))[name];
}

const NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Serialises a `Set-Cookie` header value. Encodes the value with `encodeURIComponent`. */
export function serializeCookie(name: string, value: string, attributes: CookieAttributes = {}): string {
  if (!NAME_RE.test(name)) throw new TypeError(`Invalid cookie name: ${name}`);
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (attributes.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(attributes.maxAge)}`);
  if (attributes.expires) parts.push(`Expires=${attributes.expires.toUTCString()}`);
  if (attributes.domain) parts.push(`Domain=${attributes.domain}`);
  parts.push(`Path=${attributes.path ?? '/'}`);
  if (attributes.secure) parts.push('Secure');
  if (attributes.httpOnly) parts.push('HttpOnly');
  if (attributes.sameSite) {
    const v = attributes.sameSite.toLowerCase();
    parts.push(`SameSite=${v.charAt(0).toUpperCase()}${v.slice(1)}`);
  }
  if (attributes.partitioned) parts.push('Partitioned');
  if (attributes.priority)
    parts.push(`Priority=${attributes.priority.charAt(0).toUpperCase()}${attributes.priority.slice(1)}`);
  return parts.join('; ');
}

/** A `Set-Cookie` value that deletes the cookie. */
export function expireCookie(
  name: string,
  attributes: Pick<CookieAttributes, 'domain' | 'path' | 'secure' | 'sameSite'> = {},
): string {
  return serializeCookie(name, '', { ...attributes, maxAge: 0, expires: new Date(0) });
}

/** Appends `Set-Cookie` without clobbering existing ones (Headers.append is correct for Set-Cookie). */
export function appendSetCookie(headers: Headers, value: string): void {
  headers.append('set-cookie', value);
}

/** Reads all `Set-Cookie` values (uses `getSetCookie` when available). */
export function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? splitSetCookie(raw) : [];
}

/** Splits a joined Set-Cookie header on commas that are not part of an `Expires=` date. */
export function splitSetCookie(joined: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === ';') inExpires = false;
    if (!inExpires && /expires=/i.test(joined.slice(Math.max(0, i - 8), i + 1))) inExpires = true;
    if (ch === ',' && !inExpires) {
      const next = joined.slice(i + 1).trimStart();
      if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(next)) {
        out.push(joined.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  out.push(joined.slice(start).trim());
  return out.filter(Boolean);
}
