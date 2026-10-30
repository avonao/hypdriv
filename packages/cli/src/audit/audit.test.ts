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
        expected: 'nonce',
        headers: new Headers({ 'content-type': 'text/html', 'content-security-policy': `script-src 'self' 'nonce-abc' 'sha256-${hash}' 'strict-dynamic'; object-src 'none'; base-uri 'self'` }),
        body: `<html><script nonce="abc">a()</script><script type="speculationrules">${rules}</script><script>b()</script></html>`,
      },
      {},
    );
    expect(result.findings.find((f) => f.level === 'fail')?.message).toBe('1 inline script(s) lack the policy nonce and will be blocked');
  });
});
