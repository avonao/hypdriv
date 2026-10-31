import { emptyManifest, getCurrentContext, type HypManifest, routePatternToRegex } from '@hypdriv/core';
import { signPurgeToken } from '@hypdriv/security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler, isStaticRequest } from './handler';
import { hyp, jobHandler, nonce } from './server';

const manifest: HypManifest = emptyManifest({
  buildId: 'b1',
  routes: [
    {
      id: 'page:/',
      pathname: '/',
      regex: routePatternToRegex('/'),
      kind: 'page',
      classification: 'static',
      runtime: 'nodejs',
      dynamic: false,
      assets: { js: ['/assets/index-1.js'], css: ['/assets/index-2.css'], fonts: [] },
    },
    {
      id: 'page:/account',
      pathname: '/account',
      regex: routePatternToRegex('/account'),
      kind: 'page',
      classification: 'dynamic',
      runtime: 'nodejs',
      dynamic: true,
      assets: { js: [], css: [], fonts: [] },
    },
  ],
  csp: { 'page:/': { scriptHashes: ["'sha256-abc'"], styleHashes: [] } },
});

const html = (body: string) =>
  new Response(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createHandler', () => {
  it('runs the pipeline around the upstream and injects the nonce into rendered HTML without HTMLRewriter', async () => {
    const handler = createHandler({ config: {}, manifest, target: 'node', development: false });
    let seenNonce: string | undefined;
    const response = await handler(new Request('https://example.com/account'), {
      upstream: async (forwarded) => {
        seenNonce = nonce();
        expect(forwarded.headers.get('x-hypdriv-runner')).toBe('host');
        expect(getCurrentContext()?.runner).toBe('host');
        return html('<script>window.__data = 1</script><script src="/assets/a.js"></script>');
      },
    });
    const body = await response.text();
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(seenNonce).toMatch(/^[A-Za-z0-9+/=_-]{16,}$/);
    expect(csp).toContain(`'nonce-${seenNonce}'`);
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(body).toContain(`<script nonce="${seenNonce}">window.__data = 1</script>`);
    expect(body).toContain(`<script src="/assets/a.js" nonce="${seenNonce}"></script>`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('uses the manifest hashes for static routes', async () => {
    const handler = createHandler({ config: {}, manifest, target: 'node' });
    const response = await handler(new Request('https://example.com/'), {
      upstream: async () => html('<script>static()</script>'),
    });
    expect(response.headers.get('x-hypdriv-csp')).toBe('hash');
    expect(response.headers.get('content-security-policy')).toContain("'sha256-abc'");
  });

  it('answers internal routes and the HTTPS upgrade before the application', async () => {
    const upstream = vi.fn(async () => html('app'));
    const handler = createHandler({
      config: { site: { origin: 'https://example.com' } },
      manifest,
      target: 'node',
    });
    const health = await handler(new Request('https://example.com/_hypdriv/health'), { upstream });
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    const upgrade = await handler(new Request('http://example.com/account'), { upstream });
    expect(upgrade.status).toBe(308);
    expect(upgrade.headers.get('location')).toBe('https://example.com/account');
    expect(upstream).not.toHaveBeenCalled();
  });

  describe('POST /_hypdriv/purge', () => {
    const SECRET = 'purge-secret-for-tests-0123456789abcdef';
    const purge = async (
      handler: ReturnType<typeof createHandler>,
      body: unknown,
      headers: Record<string, string> = {},
      upstream = async () => html('app'),
    ) =>
      handler(
        new Request('https://example.com/_hypdriv/purge', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
        { upstream },
      );
    const signed = async (host = 'example.com') => ({
      'x-hypdriv-purge': await signPurgeToken(SECRET, { host }),
    });

    it('does not exist for requests without a valid purge token', async () => {
      vi.stubEnv('HYPDRIV_INTERNAL_SECRET', SECRET);
      const handler = createHandler({ config: {}, manifest, target: 'node' });
      for (const headers of [
        {},
        { 'x-hypdriv-purge': 'v1.9999999999.abc' },
        await signed('other.example.com'),
      ]) {
        const res = await purge(handler, { tags: ['path:/'] }, headers);
        expect(res.status).toBe(404);
      }
      const get = await handler(new Request('https://example.com/_hypdriv/purge'), {
        upstream: async () => html('app'),
      });
      expect(get.status).toBe(404);
    });

    it('does not exist when the internal secret is not configured', async () => {
      const handler = createHandler({ config: {}, manifest, target: 'node' });
      const res = await purge(handler, { tags: ['path:/'] }, await signed());
      expect(res.status).toBe(404);
    });

    it('validates the body of a signed request', async () => {
      vi.stubEnv('HYPDRIV_INTERNAL_SECRET', SECRET);
      const handler = createHandler({ config: {}, manifest, target: 'node' });
      const headers = await signed();
      expect((await purge(handler, 'not json', headers)).status).toBe(400);
      expect((await purge(handler, {}, headers)).status).toBe(400);
      expect((await purge(handler, { tags: 'path:/' }, headers)).status).toBe(400);
      expect((await purge(handler, { paths: ['no-slash'] }, headers)).status).toBe(400);
      expect((await purge(handler, { tags: [''] }, headers)).status).toBe(400);
    });

    it('removes a cached page from the edge cache, by tag and by path', async () => {
      vi.stubEnv('HYPDRIV_INTERNAL_SECRET', SECRET);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const handler = createHandler({ config: {}, manifest, target: 'node' });
        let renders = 0;
        const upstream = async () => {
          renders++;
          return html(`render ${renders}`);
        };
        const page = async () =>
          (await handler(new Request('https://example.com/'), { upstream })).headers.get('x-hypdriv-cache');
        expect(await page()).toBe('MISS');
        expect(await page()).toBe('HIT');

        const byTag = await purge(handler, { tags: ['path:/'] }, await signed(), upstream);
        expect(byTag.status).toBe(200);
        expect(await byTag.json()).toMatchObject({ ok: true, tags: 1, urls: 0 });
        expect(await page()).toBe('MISS');
        // Purge tombstones: a response fetched within purgeGraceMs of a tag purge is not kept (ADR 0017).
        expect(await page()).toBe('MISS');
        vi.setSystemTime(Date.now() + 6000);
        expect(await page()).toBe('MISS');
        expect(await page()).toBe('HIT');

        // A purge by path removes the URL and every variant of it (through its `path:` tag, so the same window applies).
        const byPath = await purge(handler, { paths: ['/'] }, await signed(), upstream);
        expect(byPath.status).toBe(200);
        expect(await byPath.json()).toMatchObject({ ok: true, tags: 0, urls: 1 });
        expect(await page()).toBe('MISS');
        vi.setSystemTime(Date.now() + 6000);
        expect(await page()).toBe('MISS');
        expect(await page()).toBe('HIT');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('skips the pipeline for build assets but not for data paths', async () => {
    expect(isStaticRequest(new URL('https://e.com/assets/app-3f2a.js'))).toBe(true);
    expect(isStaticRequest(new URL('https://e.com/favicon.ico'))).toBe(true);
    expect(isStaticRequest(new URL('https://e.com/blog/__data.json'))).toBe(false);
    expect(isStaticRequest(new URL('https://e.com/products.data'))).toBe(false);
    expect(isStaticRequest(new URL('https://e.com/api/logo.png'))).toBe(false);
    const handler = createHandler({ config: {}, manifest, target: 'node' });
    const response = await handler(new Request('https://e.com/assets/app.js'), {
      upstream: async () => new Response('js', { headers: { 'content-type': 'text/javascript' } }),
    });
    expect(response.headers.get('x-request-id')).toBeNull();
  });

  it('strips client-supplied HypDriv headers before the application sees them', async () => {
    const handler = createHandler({ config: {}, manifest, target: 'node' });
    let flags: string | null = 'unset';
    await handler(
      new Request('https://example.com/account', {
        headers: { 'x-hypdriv-flags': 'admin=1', 'x-nonce': 'evil' },
      }),
      {
        upstream: async (forwarded) => {
          flags = forwarded.headers.get('x-hypdriv-flags');
          expect(forwarded.headers.get('x-nonce')).not.toBe('evil');
          expect(hyp()?.flags).toEqual({});
          return html('ok');
        },
      },
    );
    expect(flags).toBeNull();
  });

  it('passes through when an outer HypDriv runner already handles the request', async () => {
    const handler = createHandler({ config: {}, manifest, target: 'node' });
    const inner = vi.fn(async () => html('<script>x()</script>'));
    const response = await handler(new Request('https://example.com/account'), {
      upstream: () => handler(new Request('https://example.com/account'), { upstream: inner }),
    });
    expect(inner).toHaveBeenCalledTimes(1);
    // One pipeline: one request id, one CSP header.
    expect(response.headers.get('content-security-policy')?.split('script-src').length).toBe(2);
  });

  it('wraps a Workers-style fetch handler with env and waitUntil', async () => {
    const handler = createHandler({ config: {}, manifest, target: 'cloudflare' });
    const waits: Promise<unknown>[] = [];
    const fetch = handler.wrapFetch(async (_request: Request, _env: { NAME: string }) => {
      expect(hyp()?.env.NAME).toBe('bound');
      return html('<p>worker</p>');
    });
    const response = await fetch(
      new Request('https://example.com/account'),
      { NAME: 'bound' },
      {
        waitUntil: (p) => void waits.push(p),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<p>worker</p>');
  });

  it('applies Vercel CDN headers on function responses for every page policy', async () => {
    vi.stubEnv('VERCEL', '1');
    const handler = createHandler({
      config: {
        cache: {
          edge: { policies: [{ id: 'pages', match: '/account', ttl: 60, vary: { headers: ['x-tenant'] } }] },
        },
      },
      manifest,
    });
    const response = await handler(new Request('https://example.com/account'), {
      upstream: async () => html('ok'),
    });
    expect(response.headers.get('vercel-cdn-cache-control')).toContain('s-maxage=60');
    expect(response.headers.get('vary')?.toLowerCase()).toContain('x-tenant');
  });
});

describe('jobHandler (runtime)', () => {
  it('rejects unsigned requests outside development', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HYPDRIV_INTERNAL_SECRET', 'a'.repeat(32));
    const handle = jobHandler({}, async () => ({ done: true }));
    const response = await handle(new Request('https://example.com/api/jobs/tick', { method: 'POST' }));
    expect(response.status).toBe(401);
  });

  it('accepts Vercel Cron calls carrying CRON_SECRET', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CRON_SECRET', 'cron-secret-value');
    const handle = jobHandler({ job: 'tick' }, async (input) => ({ job: input.job }));
    const response = await handle(
      new Request('https://example.com/api/jobs/tick', {
        headers: { authorization: 'Bearer cron-secret-value' },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, job: 'tick', result: { job: 'tick' } });
  });
});
