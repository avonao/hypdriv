import { writeManifest } from '@hypdriv/core/node';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupProjects,
  fakeFetch,
  fixtureManifest,
  memoryIO,
  response,
  tempProject,
} from '../__tests__/helpers';
import { runCommand } from '../main';
import { auditCache } from './cache';
import { auditCsp, sha256Base64 } from './csp';
import { gradeHeaders } from './headers';
import { choosePaths, cspModeFor } from './paths';

afterEach(cleanupProjects);

const STRONG = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=()',
  'cross-origin-opener-policy': 'same-origin-allow-popups',
  'cross-origin-resource-policy': 'same-site',
  'cache-control': 'private, no-cache',
};

describe('gradeHeaders', () => {
  it('awards A+ for the full preset', () => {
    const g = gradeHeaders(STRONG);
    expect(g).toMatchObject({ grade: 'A+', score: 100, missing: [], deductions: [] });
    expect(g.notes).toEqual([]);
  });

  it('accepts frame-ancestors instead of X-Frame-Options', () => {
    const { 'x-frame-options': _x, ...rest } = STRONG;
    expect(gradeHeaders(rest).grade).toBe('A+');
  });

  it('deducts for leaks and weak values and lists missing headers', () => {
    const g = gradeHeaders({
      ...STRONG,
      'x-powered-by': 'Next.js',
      'content-security-policy': "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      'strict-transport-security': 'max-age=300',
    });
    expect(g.grade).toBe('B');
    expect(g.deductions.map((d) => d.reason)).toEqual(
      expect.arrayContaining([
        "script-src allows 'unsafe-inline' without nonces or hashes",
        "script-src allows 'unsafe-eval'",
        'X-Powered-By reveals "Next.js"',
        'HSTS max-age 300 is below 6 months',
      ]),
    );
    const bare = gradeHeaders(new Headers({ 'x-content-type-options': 'nosniff' }), { https: false });
    // 15 (nosniff) + 25 (HSTS is not applicable over http) = 40
    expect(bare.grade).toBe('E');
    expect(bare.missing).not.toContain('Strict-Transport-Security');
    expect(bare.missing).toContain('Content-Security-Policy');
    expect(bare.notes).toEqual(
      expect.arrayContaining([
        'Cache-Control is missing.',
        'HSTS is not graded over http (local preview); HypDriv sends it on https origins.',
      ]),
    );
    const reportOnly = gradeHeaders({ 'content-security-policy-report-only': "default-src 'self'" });
    expect(reportOnly.notes[0]).toMatch(/report-only/);
  });
});

describe('auditCsp', () => {
  const html = (nonce: string | null, inline = 'self.__next_f=[]') =>
    `<!doctype html><html><head><script src="/_next/static/a.js"${nonce ? ` nonce="${nonce}"` : ''} async></script></head><body><script${nonce ? ` nonce="${nonce}"` : ''}>${inline}</script><script type="application/json">{"x":1}</script></body></html>`;

  it('passes nonce mode when every script carries the nonce', () => {
    const r = auditCsp({
      path: '/d',
      status: 200,
      headers: new Headers({ ...STRONG, 'content-type': 'text/html' }),
      body: html('abc'),
      expected: 'nonce',
    });
    expect(r).toMatchObject({
      status: 'pass',
      mode: 'nonce',
      scripts: { inline: 1, external: 1, withNonce: 2 },
    });
  });

  it('fails nonce mode when inline scripts lack the nonce', () => {
    const r = auditCsp({
      path: '/d',
      status: 200,
      headers: new Headers({ ...STRONG, 'content-type': 'text/html' }),
      body: html(null),
      expected: 'nonce',
    });
    expect(r.status).toBe('fail');
    expect(r.findings.map((f) => f.message)).toContain(
      '1 inline script(s) lack the policy nonce and will be blocked',
    );
  });

  it('checks inline scripts against the policy hashes in hash mode', () => {
    const inline = 'self.__next_f=[]';
    const policy = `default-src 'self'; script-src 'self' 'sha256-${sha256Base64(inline)}' 'unsafe-inline'; object-src 'none'; base-uri 'self'`;
    const ok = auditCsp({
      path: '/',
      status: 200,
      headers: new Headers({ 'content-security-policy': policy, 'content-type': 'text/html' }),
      body: html(null, inline),
      expected: 'hash',
    });
    expect(ok).toMatchObject({ status: 'pass', mode: 'hash', scripts: { hashed: 1, unmatched: 0 } });
    const stale = auditCsp(
      {
        path: '/',
        status: 200,
        headers: new Headers({ 'content-security-policy': policy, 'content-type': 'text/html' }),
        body: html(null, 'changed()'),
        expected: 'hash',
      },
      { extractInlineScripts: (h) => [h.includes('changed') ? 'changed()' : ''] },
    );
    expect(stale.status).toBe('fail');
    expect(stale.findings[0]?.message).toMatch(/do not match any policy hash/);
  });

  it('flags missing policies, unsafe-inline without nonces and missing hardening directives', () => {
    expect(
      auditCsp({ path: '/', status: 200, headers: new Headers(), body: '', expected: 'nonce' }).findings[0]
        ?.message,
    ).toBe('no Content-Security-Policy header');
    const weak = auditCsp({
      path: '/',
      status: 200,
      headers: new Headers({ 'content-security-policy': "script-src 'self' 'unsafe-inline'" }),
      body: '',
      expected: 'nonce',
    });
    expect(weak.findings.map((f) => f.message)).toEqual(
      expect.arrayContaining([
        "script-src allows 'unsafe-inline' without nonces or hashes",
        "missing object-src 'none'",
        'missing base-uri',
      ]),
    );
    expect(
      auditCsp({ path: '/api', status: 200, headers: new Headers(), body: '', expected: 'none' }).status,
    ).toBe('pass');
  });
});

describe('auditCache', () => {
  const h = (init: Record<string, string>) =>
    new Headers({
      'content-type': 'text/html',
      vary: 'rsc, accept-encoding',
      'cache-control': 'public, s-maxage=300',
      ...init,
    });

  it('expects MISS then HIT with Age for cached routes', () => {
    const ok = auditCache({
      path: '/',
      hasPolicy: true,
      first: { status: 200, headers: h({ 'x-hypdriv-cache': 'MISS' }) },
      second: { status: 200, headers: h({ 'x-hypdriv-cache': 'HIT; age=2', age: '2' }) },
    });
    expect(ok).toMatchObject({ status: 'pass', first: 'MISS', second: 'HIT', age: '2' });
    const miss = auditCache({
      path: '/',
      hasPolicy: true,
      first: { status: 200, headers: h({ 'x-hypdriv-cache': 'MISS' }) },
      second: { status: 200, headers: h({ 'x-hypdriv-cache': 'MISS' }) },
    });
    expect(miss.status).toBe('fail');
    const noAge = auditCache({
      path: '/',
      hasPolicy: true,
      first: { status: 200, headers: h({ 'x-hypdriv-cache': 'MISS' }) },
      second: { status: 200, headers: h({ 'x-hypdriv-cache': 'HIT' }) },
    });
    expect(noAge.findings.map((f) => f.message)).toContain('cached response without an Age header');
  });

  it('reports a policy Vercel cannot apply to a page as a warning, not a broken cache', () => {
    const limited = h({
      'x-hypdriv-cache': 'BYPASS',
      'x-hypdriv-cache-reason': 'route-header:vary',
      'x-vercel-cache': 'MISS',
      'cache-control': 'private, no-cache, no-store',
    });
    const result = auditCache({
      path: '/geo',
      hasPolicy: true,
      first: { status: 200, headers: limited },
      second: { status: 200, headers: limited },
    });
    expect(result.status).toBe('warn');
    expect(result.findings.map((f) => f.message)).toContainEqual(
      expect.stringContaining('policy not applicable on this platform (vary)'),
    );
    // A plain BYPASS without that reason is still a failure.
    const broken = auditCache({
      path: '/geo',
      hasPolicy: true,
      first: { status: 200, headers: h({ 'x-hypdriv-cache': 'BYPASS' }) },
      second: { status: 200, headers: h({ 'x-hypdriv-cache': 'BYPASS' }) },
    });
    expect(broken.status).toBe('fail');
  });

  it('checks Vary rsc, missing headers and Vercel CDN statuses', () => {
    const noVary = auditCache({
      path: '/',
      hasPolicy: true,
      first: { status: 200, headers: h({ 'x-hypdriv-cache': 'MISS', vary: 'accept-encoding' }) },
      second: { status: 200, headers: h({ 'x-hypdriv-cache': 'STALE', vary: 'accept-encoding', age: '9' }) },
    });
    expect(noVary.findings.map((f) => f.message)).toEqual([
      expect.stringContaining('Vary does not include rsc'),
    ]);
    expect(
      auditCache({
        path: '/',
        hasPolicy: false,
        first: { status: 200, headers: new Headers() },
        second: { status: 200, headers: new Headers() },
      }).status,
    ).toBe('fail');
    const vercel = auditCache({
      path: '/',
      hasPolicy: true,
      first: { status: 200, headers: h({ 'x-vercel-cache': 'PRERENDER' }) },
      second: { status: 200, headers: h({ 'x-vercel-cache': 'HIT', age: '4' }) },
    });
    expect(vercel).toMatchObject({ status: 'pass', first: 'PRERENDER', second: 'HIT' });
  });
});

describe('path selection', () => {
  it('prefers static and ISR routes, then one path per dynamic route, then /', async () => {
    const manifest = await fixtureManifest();
    const paths = choosePaths(manifest).map((p) => p.path);
    expect(paths.slice(0, 3)).toEqual(expect.arrayContaining(['/', '/blog', '/pricing']));
    expect(paths).toContain('/blog/hello-world');
    expect(paths).toContain('/dashboard');
    expect(paths).not.toContain('/_not-found');
    expect(paths.some((p) => p.includes('['))).toBe(false);
    expect(choosePaths(manifest, { paths: ['/x', 'y'] }).map((p) => p.path)).toEqual(['/x', '/y']);
    expect(choosePaths(null).map((p) => p.path)).toEqual(['/']);
    const root = choosePaths(manifest, { paths: ['/'] })[0]!;
    expect(cspModeFor(root.route, manifest)).toBe('hash');
  });
});

describe('hypdriv audit (injected fetch)', () => {
  it('audits headers, CSP and cache against a fake server', async () => {
    const manifest = await fixtureManifest();
    const p = tempProject({ 'package.json': '{"name":"x"}' });
    await writeManifest(p.dir, manifest);
    const seen = new Map<string, number>();
    const { fetch, calls } = fakeFetch((url) => {
      const path = new URL(url).pathname;
      const n = (seen.get(path) ?? 0) + 1;
      seen.set(path, n);
      const cache = path.startsWith('/dashboard') ? 'DYNAMIC' : n === 1 ? 'MISS' : 'HIT';
      return response(`<html><body><script nonce="abc">self.x=1</script></body></html>`, {
        headers: {
          ...STRONG,
          'cache-control': 'public, s-maxage=60',
          'content-type': 'text/html; charset=utf-8',
          'x-hypdriv-cache': cache,
          age: cache === 'HIT' ? '1' : '0',
          vary: 'rsc',
        },
      });
    });
    const io = memoryIO(p.dir, { fetch });
    const code = await runCommand(
      'audit',
      ['all', '--url', 'http://localhost:8787', '--paths', '/dashboard,/blog/hello-world', '--json'],
      io,
    );
    const out = JSON.parse(io.out);
    expect(out.paths).toEqual(['/dashboard', '/blog/hello-world']);
    expect(out.headers.every((h: { grade: { grade: string } }) => h.grade.grade === 'A+')).toBe(true);
    expect(out.csp.map((c: { status: string }) => c.status)).toEqual(['pass', 'pass']);
    // the headers/CSP pass already warmed the route, so the cache pass sees HIT twice
    expect(out.cache.find((c: { path: string }) => c.path === '/blog/hello-world')).toMatchObject({
      status: 'pass',
      hasPolicy: true,
      second: 'HIT',
      age: '1',
    });
    expect(out.cache.find((c: { path: string }) => c.path === '/dashboard')).toMatchObject({
      status: 'pass',
      hasPolicy: false,
      second: 'DYNAMIC',
    });
    expect(code).toBe(0);
    const ua = calls[0]!.headers.get('user-agent')!;
    expect(ua).toMatch(/Mozilla\/5\.0 .*Chrome\//);
    expect(calls[0]!.headers.get('accept-language')).toBe('en-US,en;q=0.9');
    expect(calls[0]!.headers.get('accept')).toContain('text/html');
  });

  it('reports unreachable servers and requires --url', async () => {
    const p = tempProject({ 'package.json': '{"name":"x"}' });
    const down = memoryIO(p.dir, {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect(await runCommand('audit', ['headers', '--url', 'http://localhost:1'], down)).toBe(1);
    expect(down.out).toContain('fetch failed');
    const usage = memoryIO(p.dir);
    expect(await runCommand('audit', ['headers'], usage)).toBe(2);
    expect(await runCommand('audit', ['bogus', '--url', 'x'], memoryIO(p.dir))).toBe(2);
  });
});

describe('CSP audit with hashes alongside nonces', () => {
  it('accepts hash-listed inline scripts in nonce mode', async () => {
    const { auditCsp } = await import('./csp');
    const { createHash } = await import('node:crypto');
    const rules = '{"prerender":[]}';
    const hash = createHash('sha256').update(rules).digest('base64');
    const result = auditCsp(
      {
        path: '/',
        status: 200,
        expected: 'nonce',
        headers: new Headers({
          'content-type': 'text/html',
          'content-security-policy': `script-src 'self' 'nonce-abc' 'sha256-${hash}' 'strict-dynamic'; object-src 'none'; base-uri 'self'`,
        }),
        body: `<html><script nonce="abc">a()</script><script type="speculationrules">${rules}</script><script>b()</script></html>`,
      },
      {},
    );
    expect(result.findings.find((f) => f.level === 'fail')?.message).toBe(
      '1 inline script(s) lack the policy nonce and will be blocked',
    );
  });
});

describe('owner audit tokens', () => {
  it('signs with the internal secret from .dev.vars and binds the token to the host', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { auditAuth, describeAuditAuth, AUDIT_TOKEN_HEADER } = await import('./token');
    const { verifyAuditToken } = await import('@hypdriv/security');
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-audit-token-'));
    writeFileSync(join(root, '.dev.vars'), 'HYPDRIV_INTERNAL_SECRET="s3cret-value-for-tests"\n');
    const io = { env: {}, date: () => new Date(1_800_000_000_000) };
    const auth = await auditAuth({ root, io, base: 'http://127.0.0.1:8787' });
    expect(auth.source).toBe('.dev.vars');
    const token = auth.headers[AUDIT_TOKEN_HEADER]!;
    expect(
      await verifyAuditToken(token, 's3cret-value-for-tests', { host: '127.0.0.1', now: 1_800_000_000_000 }),
    ).toBe(true);
    expect(
      await verifyAuditToken(token, 's3cret-value-for-tests', { host: 'evil.test', now: 1_800_000_000_000 }),
    ).toBe(false);
    expect(describeAuditAuth(auth)).toContain('signed audit token (HYPDRIV_INTERNAL_SECRET from .dev.vars)');

    const anonymous = await auditAuth({ root, io, base: 'http://127.0.0.1:8787', anonymous: true });
    expect(anonymous).toMatchObject({ headers: {}, source: null, reason: '--anonymous' });
    const protectedDeployment = await auditAuth({
      root,
      io: { ...io, env: { VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-me' } },
      base: 'https://app-git-main.vercel.app',
      anonymous: true,
    });
    expect(protectedDeployment.headers).toEqual({ 'x-vercel-protection-bypass': 'bypass-me' });
    const missing = await auditAuth({ root, io, base: 'http://x.test', secretName: 'OTHER_SECRET' });
    expect(missing.headers).toEqual({});
    expect(describeAuditAuth(missing)).toContain('OTHER_SECRET is not set');
  });

  it('fails pages answered by the bot shield or rate limiter and explains how to sign', async () => {
    const { auditHeadersPages, blockedByShield, shieldHint } = await import('../commands/audit');
    const blocked = {
      url: 'http://x/',
      status: 403,
      ok: false,
      headers: new Headers({ 'x-hypdriv-bot': 'definite', 'content-type': 'application/json' }),
      body: '{"error":"forbidden"}',
      ttfbMs: 1,
      totalMs: 1,
      redirected: null,
      error: null,
    };
    expect(blockedByShield(blocked)).toBe(true);
    expect(blockedByShield({ status: 403, headers: new Headers() })).toBe(false);
    expect(blockedByShield({ status: 429, headers: new Headers({ ratelimit: '"api";r=0;t=5' }) })).toBe(true);
    const unsigned = { headers: {}, source: null, secretName: 'HYPDRIV_INTERNAL_SECRET', reason: 'x' };
    expect(shieldHint(blocked, unsigned)).toBe(
      '403 blocked by the bot shield (x-hypdriv-bot: definite); set HYPDRIV_INTERNAL_SECRET so the CLI signs its requests',
    );
    const [entry] = auditHeadersPages([{ path: '/', page: blocked }], true, unsigned);
    expect(entry).toMatchObject({ level: 'fail', grade: null, status: 403 });
    const notFound = { ...blocked, status: 404, headers: new Headers({ 'content-type': 'text/html' }) };
    expect(auditHeadersPages([{ path: '/x', page: notFound }], true)[0]!.level).not.toBe('pass');
  });
});

describe('CSP audit of the declared cached-HTML fallback', () => {
  it('warns instead of failing when HypDriv declares the unsafe-inline fallback', async () => {
    const { auditCsp } = await import('./csp');
    const policy =
      "default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'";
    const body = '<html><script>self.__next_f.push([1])</script></html>';
    const declared = auditCsp({
      path: '/blog/x',
      status: 200,
      expected: 'nonce',
      headers: new Headers({
        'content-type': 'text/html',
        'content-security-policy': policy,
        'x-hypdriv-csp': 'unsafe-inline-fallback',
      }),
      body,
    });
    expect(declared.status).toBe('warn');
    expect(declared.findings).toHaveLength(1);
    expect(declared.findings[0]!.message).toContain('cached HTML');
    const undeclared = auditCsp({
      path: '/blog/x',
      status: 200,
      expected: 'nonce',
      headers: new Headers({ 'content-type': 'text/html', 'content-security-policy': policy }),
      body,
    });
    expect(undeclared.status).toBe('fail');
  });
});

describe('cache audit on Vercel and with cookies', () => {
  it('reads the CDN plan and Vercel cache status', async () => {
    const { auditCache, cacheStatus } = await import('./cache');
    expect(cacheStatus(new Headers({ 'x-hypdriv-cache': 'CDN', 'x-vercel-cache': 'HIT' }))).toBe('HIT');
    expect(cacheStatus(new Headers({ 'x-hypdriv-cache': 'CDN' }))).toBe('CDN');
    expect(cacheStatus(new Headers({ 'x-hypdriv-cache': 'MISS', 'x-vercel-cache': 'HIT' }))).toBe('MISS');
    const planned = auditCache({
      path: '/products/1',
      hasPolicy: true,
      first: { status: 200, headers: new Headers({ 'x-hypdriv-cache': 'CDN', 'cache-control': 'public' }) },
      second: {
        status: 200,
        headers: new Headers({
          'x-hypdriv-cache': 'CDN',
          'vercel-cdn-cache-control': 's-maxage=300',
          'cache-control': 'public',
        }),
      },
    });
    expect(planned.status).toBe('pass');
    expect(planned.findings[0]).toMatchObject({ level: 'info' });
    const missing = auditCache({
      path: '/products/1',
      hasPolicy: true,
      first: { status: 200, headers: new Headers({ 'x-hypdriv-cache': 'CDN' }) },
      second: { status: 200, headers: new Headers({ 'x-hypdriv-cache': 'CDN', 'cache-control': 'public' }) },
    });
    expect(missing.status).toBe('fail');
  });

  it('explains a first visit that bypasses because it sets a cookie', async () => {
    const { auditCache } = await import('./cache');
    const result = auditCache({
      path: '/',
      hasPolicy: true,
      first: {
        status: 200,
        headers: new Headers({ 'x-hypdriv-cache': 'BYPASS', 'set-cookie': 'hyp_uid=a; Path=/' }),
      },
      second: {
        status: 200,
        headers: new Headers({ 'x-hypdriv-cache': 'HIT', age: '1', 'cache-control': 's-maxage=60' }),
      },
    });
    expect(result.status).toBe('pass');
    expect(result.findings.map((f) => f.level)).toEqual(['info']);
  });

  it('builds the Cookie header a browser would send back', async () => {
    const { cookiesFrom } = await import('./http');
    const headers = new Headers();
    headers.append('set-cookie', 'hyp_uid=abc123; Max-Age=31536000; Path=/; HttpOnly');
    headers.append('set-cookie', 'theme=dark; Path=/');
    headers.append('set-cookie', 'old=1; Max-Age=0; Path=/');
    expect(cookiesFrom(headers)).toBe('hyp_uid=abc123; theme=dark');
    expect(cookiesFrom(headers, 'old=x; keep=1')).toBe('keep=1; hyp_uid=abc123; theme=dark');
    expect(cookiesFrom(new Headers())).toBe('');
  });
});
