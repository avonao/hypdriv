import { describe, expect, it } from 'vitest';
import { expireCookie, parseCookies, serializeCookie, splitSetCookie } from './cookies';
import {
  appendLinkHeader,
  appendListHeader,
  clientIp,
  isUpgradeResponse,
  mergeHeaders,
  negotiateLanguage,
  parseCacheControl,
  parseLink,
  rebuildResponse,
  serializeLink,
  withHeaders,
  withoutHeaders,
} from './headers';
import { json, peekText, problem } from './response';
import {
  isTrackingParam,
  normalizeTrailingSlash,
  normalizeUrl,
  safeDecodePath,
  stripBasePath,
  trimTrailingSlashes,
} from './url';

describe('cookies', () => {
  it('parses and serialises', () => {
    expect(parseCookies('a=1; b=%20x; a=2; c="q"')).toEqual({ a: '1', b: ' x', c: 'q' });
    expect(serializeCookie('s', 'v v', { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 60 })).toBe(
      's=v%20v; Max-Age=60; Path=/; Secure; HttpOnly; SameSite=Lax',
    );
    expect(expireCookie('s')).toContain('Max-Age=0');
    expect(() => serializeCookie('bad name', 'x')).toThrow();
  });
  it('splits joined Set-Cookie values', () => {
    const joined = 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, b=2; Path=/';
    expect(splitSetCookie(joined)).toEqual([
      'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/',
      'b=2; Path=/',
    ]);
  });
});

describe('headers', () => {
  it('merges with append semantics for list headers', () => {
    const h = new Headers({ vary: 'Accept', 'x-a': '1' });
    mergeHeaders(h, { vary: 'Cookie', 'x-a': '2', 'set-cookie': ['a=1', 'b=2'] });
    expect(h.get('vary')).toBe('Accept, Cookie');
    expect(h.get('x-a')).toBe('2');
    expect((h as Headers & { getSetCookie(): string[] }).getSetCookie()).toEqual(['a=1', 'b=2']);
  });
  it('appendListHeader de-duplicates and handles *', () => {
    const h = new Headers({ vary: 'accept' });
    appendListHeader(h, 'vary', ['Accept', 'Cookie']);
    expect(h.get('vary')).toBe('accept, Cookie');
    appendListHeader(h, 'vary', '*');
    expect(h.get('vary')).toBe('*');
  });
  it('serialises and parses Link headers', () => {
    const value = serializeLink([
      { href: '/a.css', rel: 'preload', as: 'style' },
      { href: '/b.js', rel: 'preload', as: 'script', crossorigin: 'anonymous' },
      { href: 'https://fonts.example', rel: 'preconnect' },
      { href: '/a.css', rel: 'preload', as: 'style' },
    ]);
    expect(value).toBe(
      '</a.css>; rel=preload; as=style, </b.js>; rel=preload; as=script; crossorigin=anonymous, <https://fonts.example>; rel=preconnect',
    );
    const parsed = parseLink(value);
    expect(parsed).toHaveLength(3);
    expect(parsed[1]).toMatchObject({
      href: '/b.js',
      rel: 'preload',
      as: 'script',
      crossorigin: 'anonymous',
    });
    const h = new Headers({ link: '</x.css>; rel=preload; as=style' });
    appendLinkHeader(
      h,
      [
        { href: '/x.css', rel: 'preload', as: 'style' },
        { href: '/y.js', rel: 'modulepreload' },
      ],
      2,
    );
    expect(parseLink(h.get('link'))).toHaveLength(2);
  });
  it('parses cache-control', () => {
    expect(parseCacheControl('public, max-age=60, s-maxage=120, no-store')).toEqual({
      public: true,
      'max-age': '60',
      's-maxage': '120',
      'no-store': true,
    });
  });
  it('extracts the client ip', () => {
    expect(clientIp(new Headers({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' }))).toBe(
      '1.2.3.4',
    );
    expect(clientIp(new Headers({ 'x-forwarded-for': '10.0.0.1, 2.2.2.2, 3.3.3.3' }), 1)).toBe('2.2.2.2');
    expect(clientIp(new Headers({ 'x-forwarded-for': '10.0.0.1, 2.2.2.2' }))).toBe('2.2.2.2');
    expect(clientIp(new Headers())).toBe('0.0.0.0');
  });
  it('negotiates languages', () => {
    expect(negotiateLanguage('de-DE,de;q=0.9,en;q=0.8', ['en', 'de'], 'en')).toBe('de');
    expect(negotiateLanguage('fr', ['en', 'de'], 'en')).toBe('en');
    expect(negotiateLanguage('en-US;q=0.5, de;q=0.9', ['en', 'de'], 'en')).toBe('de');
    expect(negotiateLanguage('pt-BR', ['pt-PT', 'en'], 'en')).toBe('pt-PT');
    expect(negotiateLanguage(null, ['en'], 'en')).toBe('en');
  });
  it('withHeaders keeps body and status', async () => {
    const r = withHeaders(new Response('hi', { status: 201 }), { 'x-y': 'z' });
    expect(r.status).toBe(201);
    expect(r.headers.get('x-y')).toBe('z');
    expect(await r.text()).toBe('hi');
  });
});

describe('upgrade responses', () => {
  // Node cannot construct a 101 response, so a stand-in carries what a Workers upgrade response has.
  const upgrade = () =>
    ({
      status: 101,
      statusText: 'Switching Protocols',
      headers: new Headers({ upgrade: 'websocket' }),
      body: null,
    }) as Response;

  it('recognises a protocol switch and a response carrying a webSocket', () => {
    expect(isUpgradeResponse(upgrade())).toBe(true);
    expect(isUpgradeResponse(Object.assign(new Response('x'), { webSocket: {} }))).toBe(true);
    expect(isUpgradeResponse(new Response('x'))).toBe(false);
  });

  it('hands the upgrade back instead of throwing when the runtime cannot rebuild it', () => {
    const response = upgrade();
    expect(withHeaders(response, { 'x-a': '1' })).toBe(response);
    expect(withoutHeaders(response, ['upgrade'])).toBe(response);
    expect(rebuildResponse(response, new Headers())).toBe(response);
  });

  it('still rebuilds ordinary responses with their body and status', async () => {
    const out = withHeaders(new Response('body', { status: 203, headers: { a: '1' } }), { b: '2' });
    expect([out.status, out.headers.get('a'), out.headers.get('b'), await out.text()]).toEqual([
      203,
      '1',
      '2',
      'body',
    ]);
  });
});

describe('url', () => {
  it('normalises for cache keys', () => {
    const u = normalizeUrl('HTTPS://Example.COM:443/a//b/?utm_source=x&z=1&a=2&fbclid=y#frag');
    expect(u.href).toBe('https://example.com/a/b?a=2&z=1');
  });
  it('supports keepQuery options', () => {
    expect(normalizeUrl('https://x.test/p?b=1&a=2', { keepQuery: ['a'] }).search).toBe('?a=2');
    expect(normalizeUrl('https://x.test/p?b=1&a=2', { keepQuery: 'none' }).search).toBe('');
  });
  it('applies trailing slash rules', () => {
    expect(trimTrailingSlashes('/a///')).toBe('/a');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('/a/b')).toBe('/a/b');
    expect(trimTrailingSlashes(`${'/'.repeat(200_000)}x`)).toBe(`${'/'.repeat(200_000)}x`);
    expect(normalizeTrailingSlash('/a/', null)).toBe('/a');
    expect(normalizeTrailingSlash('/a', true)).toBe('/a/');
    expect(normalizeTrailingSlash('/a.txt', true)).toBe('/a.txt');
    expect(normalizeTrailingSlash('/', true)).toBe('/');
  });
  it('preserves the trailing slash on request, still cleaning the rest of the URL', () => {
    expect(normalizeUrl('https://x.test/a/', { trailingSlash: 'preserve' }).pathname).toBe('/a/');
    expect(normalizeUrl('https://x.test/a', { trailingSlash: 'preserve' }).pathname).toBe('/a');
    expect(normalizeUrl('https://X.test//a//b/', { trailingSlash: 'preserve' }).href).toBe(
      'https://x.test/a/b/',
    );
  });
  it('detects tracking params', () => {
    expect(isTrackingParam('utm_whatever')).toBe(true);
    expect(isTrackingParam('gclid')).toBe(true);
    expect(isTrackingParam('page')).toBe(false);
  });
  it('rejects traversal', () => {
    expect(safeDecodePath('/a/../b')).toBeNull();
    expect(safeDecodePath('/a/%2e%2e/b')).toBeNull();
    expect(safeDecodePath('/a%00')).toBeNull();
    expect(safeDecodePath('/ok/path%20x')).toBe('/ok/path x');
  });
  it('strips base paths', () => {
    expect(stripBasePath('/docs/a', '/docs')).toBe('/a');
    expect(stripBasePath('/docs', '/docs')).toBe('/');
    expect(stripBasePath('/other', '/docs')).toBe('/other');
  });
});

describe('response helpers', () => {
  it('builds json and problem responses', async () => {
    const r = json({ a: 1 }, { status: 201 });
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual({ a: 1 });
    const p = problem(404, 'Not Found', 'nope');
    expect(p.status).toBe(404);
    expect(await p.json()).toMatchObject({ title: 'Not Found', status: 404, detail: 'nope' });
  });
  it('peeks at a body without consuming it', async () => {
    const { text, response } = await peekText(new Response('body'));
    expect(text).toBe('body');
    expect(await response.text()).toBe('body');
  });
});

describe('sanitizeInboundRequest', () => {
  it('drops spoofable Hypdriv, nonce and middleware headers and keeps trusted ones', async () => {
    const { sanitizeInboundRequest } = await import('./headers');
    const request = new Request('https://x.test/', {
      headers: {
        'x-hypdriv-flags': '{"admin":true}',
        'x-hypdriv-geo': 'forged',
        'x-hypdriv-runner': 'worker',
        'x-nonce': 'attacker',
        'x-middleware-subrequest': 'middleware',
        'x-hypdriv-request-id': 'req-1',
        'x-hypdriv-signature': 'sig',
        'x-hypdriv-timestamp': '1',
        accept: 'text/html',
      },
    });
    const clean = sanitizeInboundRequest(request);
    expect([...clean.headers.keys()].sort()).toEqual([
      'accept',
      'x-hypdriv-request-id',
      'x-hypdriv-signature',
      'x-hypdriv-timestamp',
    ]);
    const custom = sanitizeInboundRequest(
      new Request('https://x.test/', { headers: { 'x-csp-nonce': 'a', 'x-nonce': 'b' } }),
      { nonceHeader: 'x-csp-nonce' },
    );
    expect([...custom.headers.keys()]).toEqual(['x-nonce']);
  });

  it('returns the original request when nothing is removed', async () => {
    const { sanitizeInboundRequest } = await import('./headers');
    const request = new Request('https://x.test/', { headers: { accept: '*/*' } });
    expect(sanitizeInboundRequest(request)).toBe(request);
  });
});
describe('withRequestHeaders', () => {
  /** A srvx-style lazy request: passes `instanceof Request` but cannot be the input of `new Request()`. */
  function lookAlike(inner: Request): Request {
    const fake = Object.create(Request.prototype) as Request & { _request?: Request };
    for (const key of ['url', 'method', 'headers', 'body', 'signal', 'redirect'] as const)
      Object.defineProperty(fake, key, { get: () => inner[key] });
    return fake;
  }

  it('copies native requests with new headers', async () => {
    const { withRequestHeaders } = await import('./headers');
    const copy = withRequestHeaders(
      new Request('https://x.test/a', { headers: { a: '1' } }),
      new Headers({ b: '2' }),
    );
    expect(copy.headers.get('b')).toBe('2');
    expect(copy.headers.has('a')).toBe(false);
  });

  it('unwraps or rebuilds look-alike requests, body included', async () => {
    const { withRequestHeaders } = await import('./headers');
    const inner = new Request('https://x.test/form', { method: 'POST', body: 'x=1' });
    const wrapped = Object.assign(lookAlike(inner), { _request: inner });
    expect(() => new Request(wrapped, { headers: new Headers() })).toThrow(TypeError);
    const unwrapped = withRequestHeaders(wrapped, new Headers({ c: '3' }));
    expect(unwrapped.headers.get('c')).toBe('3');
    expect(await unwrapped.text()).toBe('x=1');
    const rebuilt = withRequestHeaders(
      lookAlike(new Request('https://x.test/form', { method: 'POST', body: 'y=2' })),
      new Headers({ d: '4' }),
    );
    expect(rebuilt.method).toBe('POST');
    expect(rebuilt.url).toBe('https://x.test/form');
    expect(await rebuilt.text()).toBe('y=2');
  });
});
