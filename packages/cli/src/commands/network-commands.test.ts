import { writeManifest } from '@hypdriv/core/node';
import { verifyInternalRequest, verifyPurgeToken } from '@hypdriv/security';
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
import { summarizeSamples } from './bench';
import { configuredExperiments, parseSince } from './experiments';
import { rateVital, vitalsSql } from './vitals';
import { warmPaths } from './warm';

afterEach(cleanupProjects);

describe('warm', () => {
  it('chooses configured routes, explicit paths or static/ISR routes', async () => {
    const manifest = await fixtureManifest();
    expect(warmPaths(manifest, ['/a'], [])).toEqual(['/a']);
    expect(warmPaths(manifest, ['/a'], ['/b'])).toEqual(['/b']);
    const auto = warmPaths(manifest, [], []);
    expect(auto).toEqual(
      expect.arrayContaining(['/', '/blog', '/pricing', '/blog/hello-world', '/blog/second']),
    );
    expect(auto).not.toContain('/dashboard');
    expect(warmPaths(null, [], [])).toEqual(['/']);
  });

  it('fetches every path with a browser UA and reports cache statuses', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts':
        "export default { cache: { warm: { routes: ['/', '/pricing'], concurrency: 2 } } };\n",
    });
    const { fetch, calls } = fakeFetch((url) =>
      response('<html></html>', {
        status: url.endsWith('/pricing') ? 503 : 200,
        headers: { 'x-hypdriv-cache': 'MISS' },
      }),
    );
    const io = memoryIO(p.dir, { fetch });
    const code = await runCommand('warm', ['--url', 'https://shop.test', '--json'], io);
    const out = JSON.parse(io.out);
    expect(
      out.results.map((r: { path: string; status: number; cache: string }) => [r.path, r.status, r.cache]),
    ).toEqual([
      ['/', 200, 'MISS'],
      ['/pricing', 503, 'MISS'],
    ]);
    expect(out.failed).toBe(1);
    expect(code).toBe(1);
    expect(calls.map((c) => c.url)).toEqual(['https://shop.test/', 'https://shop.test/pricing']);
    expect(calls[0]!.headers.get('user-agent')).toContain('Mozilla/5.0');
  });

  it('marks every request as a warm-up, so it is neither assigned to an experiment nor counted', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': "export default { cache: { warm: { routes: ['/'] } } };\n",
    });
    const { fetch, calls } = fakeFetch(() => response('<html></html>'));
    const io = memoryIO(p.dir, { fetch });
    expect(await runCommand('warm', ['--url', 'https://shop.test', '--anonymous', '--json'], io)).toBe(0);
    expect(calls.map((c) => c.headers.get('x-hypdriv-warm'))).toEqual(['1']);
    expect(calls[0]!.headers.get('cookie')).toBeNull();
  });

  it('requests each experiment variant of a page the cache keeps apart', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': `export default {
        flags: { definitions: {
          checkout: { default: 'control', experiment: { variants: { control: 1, b: 1 } } },
        } },
        cache: { warm: { routes: ['/', '/dashboard'] }, edge: { policies: [{ match: '/', ttl: 60 }] } },
      };\n`,
    });
    const { fetch, calls } = fakeFetch(() =>
      response('<html></html>', { headers: { 'x-hypdriv-cache': 'MISS' } }),
    );
    const io = memoryIO(p.dir, { fetch });
    expect(await runCommand('warm', ['--url', 'https://shop.test', '--anonymous', '--json'], io)).toBe(0);
    const out = JSON.parse(io.out);
    // `/` has a policy that varies on the experiment: two copies. `/dashboard` has none: one plain request.
    expect(calls.map((c) => [new URL(c.url).pathname, c.headers.get('cookie')])).toEqual([
      ['/', 'hyp_exp=checkout%3Acontrol'],
      ['/', 'hyp_exp=checkout%3Ab'],
      ['/dashboard', null],
    ]);
    expect(calls.every((c) => c.headers.get('x-hypdriv-warm') === '1')).toBe(true);
    expect(out.results.map((r: { path: string; variant?: unknown }) => [r.path, r.variant ?? null])).toEqual([
      ['/', { checkout: 'control' }],
      ['/', { checkout: 'b' }],
      ['/dashboard', null],
    ]);
  });
});

describe('warm --hot', () => {
  const wrangler =
    '{ "analytics_engine_datasets": [{ "binding": "HYPDRIV_ANALYTICS", "dataset": "shop_vitals" }] }';
  const rows = {
    data: [
      { pathname: '/blog/hello-world', views: 900 },
      { pathname: '/dashboard', views: 800 },
      { pathname: '//evil.test/x', views: 700 },
      { pathname: '/pricing', views: 400 },
      { pathname: '/blog/second', views: 3 },
    ],
  };
  const handler = (url: string) =>
    url.startsWith('https://api.cloudflare.com/')
      ? response(JSON.stringify(rows))
      : response('<html></html>', { headers: { 'x-hypdriv-cache': 'MISS' } });
  const env = { CF_ACCOUNT_ID: 'acc123', CF_API_TOKEN: 'tok' };

  async function project(config = "export default { cache: { warm: { routes: ['/'] } } };\n") {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': config,
      'wrangler.jsonc': wrangler,
    });
    await writeManifest(p.dir, await fixtureManifest());
    return p;
  }

  it('adds the busiest pages the edge cache would keep to the configured routes', async () => {
    const p = await project();
    const { fetch, calls } = fakeFetch(handler);
    const io = memoryIO(p.dir, { fetch, env });
    const code = await runCommand('warm', ['--url', 'https://shop.test', '--hot', '--json'], io);
    expect(code).toBe(0);
    const out = JSON.parse(io.out);
    expect(out.hot).toEqual([
      { path: '/blog/hello-world', views: 900 },
      { path: '/pricing', views: 400 },
    ]);
    expect(out.results.map((r: { path: string }) => r.path)).toEqual(['/', '/blog/hello-world', '/pricing']);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql');
    expect(calls[0]!.body).toContain('FROM shop_vitals');
    expect(calls[0]!.body).toContain("INTERVAL '7' DAY");
  });

  it('takes the window, limit and threshold from the flags and from cache.warm.hot', async () => {
    const p = await project(
      'export default { cache: { warm: { hot: { limit: 1, days: 3, minViews: 500 } } } };\n',
    );
    const { fetch, calls } = fakeFetch(handler);
    const io = memoryIO(p.dir, { fetch, env });
    await runCommand('warm', ['--url', 'https://shop.test', '--hot', '--json'], io);
    expect(calls[0]!.body).toContain("INTERVAL '3' DAY");
    expect(JSON.parse(io.out).hot).toEqual([{ path: '/blog/hello-world', views: 900 }]);
    const flags = memoryIO(p.dir, { fetch, env });
    await runCommand(
      'warm',
      ['--url', 'https://shop.test', '--hot', '--min-views', '1', '--limit', '3', '--days', '30', '--json'],
      flags,
    );
    expect(JSON.parse(flags.out).hot.map((h: { path: string }) => h.path)).toEqual([
      '/blog/hello-world',
      '/pricing',
      '/blog/second',
    ]);
    expect(calls.filter((c) => c.url.startsWith('https://api.cloudflare.com/')).at(-1)!.body).toContain(
      "INTERVAL '30' DAY",
    );
  });

  it('prints the SQL without credentials and degrades clearly without them', async () => {
    const p = await project();
    const sql = memoryIO(p.dir);
    expect(await runCommand('warm', ['--url', 'https://shop.test', '--hot', '--sql'], sql)).toBe(0);
    expect(sql.out).toContain("blob1 = 'TTFB'");
    const none = memoryIO(p.dir);
    expect(await runCommand('warm', ['--url', 'https://shop.test', '--hot'], none)).toBe(1);
    expect(none.err).toContain('CF_ACCOUNT_ID and CF_API_TOKEN');
    const bare = tempProject({ 'package.json': '{"name":"x"}', 'wrangler.jsonc': '{}' });
    const noDataset = memoryIO(bare.dir);
    expect(await runCommand('warm', ['--url', 'https://shop.test', '--hot'], noDataset)).toBe(1);
    expect(noDataset.err).toContain('No Analytics Engine dataset');
  });

  it('says so when nothing is hot yet, and still warms the default routes', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': 'export default {};\n',
      'wrangler.jsonc': wrangler,
    });
    const { fetch, calls } = fakeFetch((url) =>
      url.startsWith('https://api.cloudflare.com/')
        ? response(JSON.stringify({ data: [] }))
        : response('<html></html>'),
    );
    const io = memoryIO(p.dir, { fetch, env });
    expect(await runCommand('warm', ['--url', 'https://shop.test', '--hot'], io)).toBe(0);
    expect(io.out).toContain('No hot pages yet');
    expect(calls.filter((c) => !c.url.startsWith('https://api.cloudflare.com/')).map((c) => c.url)).toEqual([
      'https://shop.test/',
    ]);
  });

  it('keeps the default static/ISR routes when nothing is configured', async () => {
    const p = await project('export default {};\n');
    const { fetch, calls } = fakeFetch(handler);
    const io = memoryIO(p.dir, { fetch, env });
    expect(await runCommand('warm', ['--url', 'https://shop.test', '--hot', '--json'], io)).toBe(0);
    const warmed = JSON.parse(io.out).results.map((r: { path: string }) => r.path);
    expect(warmed).toEqual(expect.arrayContaining(['/', '/blog', '/pricing', '/blog/hello-world']));
    expect(warmed).not.toContain('/dashboard');
    expect(new Set(warmed).size).toBe(warmed.length);
    expect(calls.some((c) => c.url.endsWith('/dashboard'))).toBe(false);
  });

  it('fails closed without a manifest: only pages an explicit policy keeps are warmed', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': "export default { cache: { warm: { routes: ['/'] } } };\n",
      'wrangler.jsonc': wrangler,
    });
    const { fetch, calls } = fakeFetch(handler);
    const io = memoryIO(p.dir, { fetch, env });
    expect(await runCommand('warm', ['--url', 'https://shop.test', '--hot', '--json'], io)).toBe(0);
    expect(JSON.parse(io.out).hot).toEqual([]);
    expect(calls.filter((c) => !c.url.startsWith('https://api.cloudflare.com/')).map((c) => c.url)).toEqual([
      'https://shop.test/',
    ]);

    const policy = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts':
        "export default { cache: { warm: { routes: ['/'] }, edge: { policies: [{ match: '/blog/**', ttl: 60 }] } } };\n",
      'wrangler.jsonc': wrangler,
    });
    const second = memoryIO(policy.dir, { fetch, env });
    expect(await runCommand('warm', ['--url', 'https://shop.test', '--hot', '--json'], second)).toBe(0);
    expect(JSON.parse(second.out).hot).toEqual([{ path: '/blog/hello-world', views: 900 }]);
  });

  it('never requests an encoded alias of a dot segment or an internal path', async () => {
    const forged = {
      data: [
        { pathname: '/blog/%2e%2e/%2e%2e/_hypdriv/live/x', views: 5000 },
        { pathname: '/%5Fhypdriv/purge', views: 4000 },
        { pathname: '/%70ricing', views: 300 },
        { pathname: '/pricing', views: 200 },
      ],
    };
    const p = await project();
    const { fetch, calls } = fakeFetch((url) =>
      url.startsWith('https://api.cloudflare.com/')
        ? response(JSON.stringify(forged))
        : response('<html></html>'),
    );
    const io = memoryIO(p.dir, { fetch, env });
    expect(await runCommand('warm', ['--url', 'https://shop.test', '--hot', '--json'], io)).toBe(0);
    expect(JSON.parse(io.out).hot).toEqual([{ path: '/pricing', views: 500 }]);
    expect(calls.filter((c) => !c.url.startsWith('https://api.cloudflare.com/')).map((c) => c.url)).toEqual([
      'https://shop.test/',
      'https://shop.test/pricing',
    ]);
  });
});

describe('purge', () => {
  const secret = 'p'.repeat(40);
  const project = () =>
    tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': 'export default {};\n',
      '.dev.vars': `HYPDRIV_INTERNAL_SECRET="${secret}"\n`,
    });
  const ok = () =>
    response(JSON.stringify({ ok: true, tags: 1, urls: 1, entriesRemoved: 3 }), {
      headers: { 'content-type': 'application/json' },
    });

  it('posts a host-bound signed token with the tags and paths, and never prints the secret', async () => {
    const p = project();
    const { fetch, calls } = fakeFetch(ok);
    const io = memoryIO(p.dir, { fetch });
    const code = await runCommand(
      'purge',
      ['--url', 'https://shop.test', '--tag', 'route:/blog', '--path', '/pricing', '--path', '/pricing'],
      io,
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://shop.test/_hypdriv/purge', method: 'POST' });
    const token = calls[0]!.headers.get('x-hypdriv-purge');
    expect(await verifyPurgeToken(token, secret, { host: 'shop.test' })).toBe(true);
    expect(await verifyPurgeToken(token, secret, { host: 'other.test' })).toBe(false);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ tags: ['route:/blog'], paths: ['/pricing'] });
    expect(io.out).toContain('Purged 1 tag(s) and 1 URL(s)');
    expect(io.out + io.err).not.toContain(secret);
    expect(io.out + io.err).not.toContain(token!);
  });

  it('--all purges the build tag of the local manifest; absolute URLs go to urls', async () => {
    const p = project();
    const manifest = await fixtureManifest();
    await writeManifest(p.dir, manifest);
    const { fetch, calls } = fakeFetch(ok);
    const io = memoryIO(p.dir, { fetch });
    const code = await runCommand(
      'purge',
      ['--url', 'https://shop.test', '--all', '--path', 'https://shop.test/a', '--json'],
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      tags: [`build:${manifest.buildId}`],
      urls: ['https://shop.test/a'],
    });
    expect(JSON.parse(io.out)).toMatchObject({ status: 200, ok: true, response: { entriesRemoved: 3 } });
  });

  it('sends gateway headers (--header) next to the token', async () => {
    const p = project();
    const { fetch, calls } = fakeFetch(ok);
    const io = memoryIO(p.dir, { fetch });
    expect(
      await runCommand(
        'purge',
        ['--url', 'https://shop.test', '--path', '/', '--header', 'cookie: gate=1'],
        io,
      ),
    ).toBe(0);
    expect(calls[0]!.headers.get('cookie')).toBe('gate=1');
    expect(calls[0]!.headers.get('x-hypdriv-purge')).toBeTruthy();
  });

  it('--all without a local build manifest is a usage error and sends nothing', async () => {
    const p = project();
    const { fetch, calls } = fakeFetch(ok);
    const io = memoryIO(p.dir, { fetch });
    expect(await runCommand('purge', ['--url', 'https://shop.test', '--all'], io)).toBe(2);
    expect(io.err).toContain('local build manifest');
    expect(calls).toHaveLength(0);
  });

  it('explains a 404 and a gateway answer, and exits 1', async () => {
    const p = project();
    const missing = fakeFetch(() => response('{"error":"not_found"}', { status: 404 }));
    const io = memoryIO(p.dir, { fetch: missing.fetch });
    expect(await runCommand('purge', ['--url', 'https://shop.test', '--path', '/'], io)).toBe(1);
    expect(io.out + io.err).toContain('does not exist for this request');
    const gated = fakeFetch(() => response('', { status: 307, headers: { location: '/gate' } }));
    const io2 = memoryIO(p.dir, { fetch: gated.fetch });
    expect(await runCommand('purge', ['--url', 'https://shop.test', '--path', '/', '--json'], io2)).toBe(1);
    expect(JSON.parse(io2.out)).toMatchObject({ status: 307, ok: false });
    expect(JSON.parse(io2.out).error).toContain('--header');
  });

  it('reports a network failure and rejects bad usage', async () => {
    const p = project();
    const failing = (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    const io = memoryIO(p.dir, { fetch: failing });
    expect(await runCommand('purge', ['--url', 'https://shop.test', '--tag', 'x'], io)).toBe(1);
    expect(io.out + io.err).toContain('ECONNREFUSED');
    expect(await runCommand('purge', ['--url', 'https://shop.test'], memoryIO(p.dir))).toBe(2);
    expect(await runCommand('purge', ['--tag', 'x'], memoryIO(p.dir))).toBe(2);
    expect(
      await runCommand('purge', ['--url', 'https://shop.test', '--path', 'no-slash'], memoryIO(p.dir)),
    ).toBe(2);
    const bare = tempProject({ 'package.json': '{"name":"x"}', 'hypdriv.config.ts': 'export default {};\n' });
    const noSecret = memoryIO(bare.dir);
    expect(await runCommand('purge', ['--url', 'https://shop.test', '--tag', 'x'], noSecret)).toBe(2);
    expect(noSecret.err).toContain('HYPDRIV_INTERNAL_SECRET is not set');
  });
});

describe('bench', () => {
  it('summarises TTFB percentiles and distributions', () => {
    const samples = [10, 20, 30, 40, 100].map((t, i) => ({
      status: i === 4 ? 500 : 200,
      ttfbMs: t,
      totalMs: t + 5,
      cache: i < 2 ? 'MISS' : 'HIT',
      error: null,
    }));
    const s = summarizeSamples('/', [
      ...samples,
      { status: 0, ttfbMs: 0, totalMs: 0, cache: null, error: 'timeout' },
    ]);
    expect(s.ttfb).toEqual({ p50: 30, p95: 100, max: 100, min: 10, mean: 40 });
    expect(s.statuses).toEqual({ '200': 4, '500': 1, error: 1 });
    expect(s.cache).toEqual({ MISS: 2, HIT: 3 });
    expect(s.errors).toBe(1);
  });

  it('measures time to first byte with an injected clock and fetch', async () => {
    const p = tempProject({ 'package.json': '{"name":"x"}' });
    let clock = 0;
    const { fetch, calls } = fakeFetch(() => {
      clock += 7;
      return response('hello', { headers: { 'x-hypdriv-cache': 'HIT' } });
    });
    const io = memoryIO(p.dir, { fetch, now: () => clock });
    const code = await runCommand(
      'bench',
      [
        '--url',
        'http://localhost:8787',
        '--paths',
        '/,/a',
        '--n',
        '4',
        '--concurrency',
        '1',
        '--warmup',
        '1',
        '--json',
      ],
      io,
    );
    expect(code).toBe(0);
    const out = JSON.parse(io.out);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({
      path: '/',
      n: 4,
      statuses: { '200': 4 },
      cache: { HIT: 4 },
      errors: 0,
    });
    expect(out.results[0].ttfb.p50).toBe(7);
    expect(calls).toHaveLength(10);
  });
});

describe('jobs', () => {
  const config =
    "export default { jobs: { cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } }, queues: { emails: { path: '/api/queues/emails' } } } };\n";

  it('lists jobs', async () => {
    const p = tempProject({ 'package.json': '{"name":"x"}', 'hypdriv.config.ts': config });
    const io = memoryIO(p.dir);
    expect(await runCommand('jobs', ['list', '--json'], io)).toBe(0);
    expect(JSON.parse(io.out).jobs.map((j: { name: string; kind: string }) => `${j.kind}:${j.name}`)).toEqual(
      ['cron:digest', 'queue:emails'],
    );
  });

  it('signs the request with HYPDRIV_INTERNAL_SECRET from .dev.vars', async () => {
    const secret = 's'.repeat(40);
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': config,
      '.dev.vars': `HYPDRIV_INTERNAL_SECRET="${secret}"\n`,
    });
    let verified = false;
    const { fetch, calls } = fakeFetch(async (_url, init) => {
      verified = await verifyInternalRequest(init.request!.clone() as Request, secret);
      return response(JSON.stringify({ ok: true, sent: 3 }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const io = memoryIO(p.dir, { fetch });
    const code = await runCommand(
      'jobs',
      ['run', 'digest', '--url', 'http://localhost:8787', '--payload', '{"dry":true}', '--json'],
      io,
    );
    expect(code).toBe(0);
    expect(verified).toBe(true);
    expect(calls[0]).toMatchObject({ url: 'http://localhost:8787/api/jobs/digest', method: 'POST' });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      job: 'digest',
      cron: '0 9 * * 1',
      payload: { dry: true },
    });
    expect(JSON.parse(io.out)).toMatchObject({
      status: 200,
      ok: true,
      signedWith: ['HYPDRIV_INTERNAL_SECRET'],
      response: { sent: 3 },
    });
    expect(io.out).not.toContain(secret);
  });

  it('uses GET with the CRON_SECRET bearer on Vercel and fails without secrets', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'vercel.json': '{}',
      'hypdriv.config.ts': config,
    });
    const { fetch, calls } = fakeFetch(() => response('{}'));
    const io = memoryIO(p.dir, { fetch, env: { CRON_SECRET: 'cron-secret-value' } });
    expect(await runCommand('jobs', ['run', 'digest', '--url', 'https://site.vercel.app'], io)).toBe(0);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://site.vercel.app/api/jobs/digest?job=digest',
    });
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer cron-secret-value');
    const none = memoryIO(p.dir);
    expect(await runCommand('jobs', ['run', 'digest', '--url', 'https://site.vercel.app'], none)).toBe(1);
    expect(none.err).toContain('HYPDRIV_INTERNAL_SECRET is not set');
    expect(await runCommand('jobs', ['run', 'nope', '--url', 'https://x.test'], memoryIO(p.dir))).toBe(1);
  });
});

describe('vitals', () => {
  it('builds Analytics Engine SQL with p75 per route and metric', () => {
    const sql = vitalsSql('shop_vitals', { days: 7, route: "/blog/[slug]'" });
    expect(sql).toContain('quantileWeighted(0.75, double1, _sample_interval) AS p75');
    expect(sql).toContain('FROM shop_vitals');
    expect(sql).toContain("INTERVAL '7' DAY");
    expect(sql).toContain("index1 = '/blog/[slug]\\''");
    expect(sql).toContain('GROUP BY route, metric');
    // Spans from the Analytics Engine trace exporter may share the dataset; they never count as vitals.
    expect(sql).toContain("blob1 IN ('LCP', 'INP', 'CLS', 'FCP', 'TTFB')");
    expect(() => vitalsSql('bad name;', { days: 1 })).toThrow();
    expect(rateVital('LCP', 2400)).toBe('good');
    expect(rateVital('INP', 300)).toBe('needs-improvement');
    expect(rateVital('CLS', 0.3)).toBe('poor');
  });

  it('queries the SQL API with the token and prints p75 rows', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'wrangler.jsonc':
        '{ "analytics_engine_datasets": [{ "binding": "HYPDRIV_ANALYTICS", "dataset": "shop_vitals" }] }',
    });
    const { fetch, calls } = fakeFetch(() =>
      response(
        JSON.stringify({
          meta: [],
          data: [
            { route: '/', metric: 'LCP', p75: 1800, p50: 1200, samples: 420 },
            { route: '/', metric: 'CLS', p75: 0.02, p50: 0.01, samples: 400 },
          ],
          rows: 2,
        }),
      ),
    );
    const io = memoryIO(p.dir, { fetch, env: { CF_ACCOUNT_ID: 'acc123', CF_API_TOKEN: 'tok' } });
    expect(await runCommand('vitals', ['--days', '3'], io)).toBe(0);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(calls[0]!.body).toContain("INTERVAL '3' DAY");
    expect(io.out).toContain('1800 ms');
    expect(io.out).toContain('0.020');
    const json = memoryIO(p.dir, { fetch, env: { CF_ACCOUNT_ID: 'acc123', CF_API_TOKEN: 'tok' } });
    await runCommand('vitals', ['--json'], json);
    expect(JSON.parse(json.out).rows[0]).toEqual({
      route: '/',
      metric: 'LCP',
      p75: 1800,
      p50: 1200,
      samples: 420,
      rating: 'good',
    });
  });

  it('prints p75 over time with --trend, and the trend SQL with --sql', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'wrangler.jsonc':
        '{ "analytics_engine_datasets": [{ "binding": "HYPDRIV_ANALYTICS", "dataset": "shop_vitals" }] }',
    });
    const { fetch, calls } = fakeFetch(() =>
      response(
        JSON.stringify({
          data: [
            { bucket: '2026-10-31 06:00:00', metric: 'LCP', p75: 2600, samples: 90 },
            { bucket: '2026-10-31 00:00:00', metric: 'LCP', p75: 1900, samples: 80 },
            { bucket: '2026-10-31 00:00:00', metric: 'CLS', p75: 0.31, samples: 70 },
          ],
        }),
      ),
    );
    const env = { CF_ACCOUNT_ID: 'acc123', CF_API_TOKEN: 'tok' };
    const io = memoryIO(p.dir, { fetch, env });
    expect(await runCommand('vitals', ['--trend', '--days', '3'], io)).toBe(0);
    expect(calls[0]!.body).toContain("toStartOfInterval(timestamp, INTERVAL '6' HOUR)");
    expect(io.out).toContain('2026-10-31 00:00');
    expect(io.out.indexOf('2026-10-31 00:00')).toBeLessThan(io.out.indexOf('2026-10-31 06:00'));
    expect(io.out).toContain('1900 ms');
    expect(io.out).toContain('2600 ms');
    expect(io.out).toContain('0.310');
    const json = memoryIO(p.dir, { fetch, env });
    await runCommand('vitals', ['--trend', '--json'], json);
    expect(JSON.parse(json.out).trend[0]).toEqual({
      bucket: '2026-10-31T00:00:00.000Z',
      LCP: 1900,
      CLS: 0.31,
      samples: 80,
    });
    const sql = memoryIO(p.dir);
    expect(await runCommand('vitals', ['--trend', '--sql'], sql)).toBe(0);
    expect(sql.out).toContain('GROUP BY bucket, metric');
  });

  it('degrades clearly without credentials or a dataset', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'wrangler.jsonc':
        '{ "analytics_engine_datasets": [{ "binding": "HYPDRIV_ANALYTICS", "dataset": "shop_vitals" }] }',
    });
    const io = memoryIO(p.dir);
    expect(await runCommand('vitals', [], io)).toBe(1);
    expect(io.err).toContain('CF_ACCOUNT_ID and CF_API_TOKEN');
    const none = tempProject({ 'package.json': '{"name":"x"}', 'wrangler.jsonc': '{}' });
    const io2 = memoryIO(none.dir);
    expect(await runCommand('vitals', [], io2)).toBe(1);
    expect(io2.err).toContain('No Analytics Engine dataset');
    const vercel = tempProject({ 'package.json': '{"name":"x"}', 'vercel.json': '{}' });
    const io3 = memoryIO(vercel.dir);
    expect(await runCommand('vitals', [], io3)).toBe(1);
    expect(io3.err).toContain('Speed Insights');
  });
});

describe('experiments', () => {
  const config = `export default {
  flags: {
    definitions: {
      checkout: {
        default: 'control',
        description: 'New checkout',
        experiment: { variants: { control: 50, b: 50 }, traffic: 80, when: { country: ['US'] } },
      },
      hero: { default: 'a', experiment: { variants: { a: 1, b: 1, c: 2 }, status: 'concluded', winner: 'c' } },
      banner: { default: true },
    },
  },
};
`;
  const wrangler =
    '{ "analytics_engine_datasets": [{ "binding": "HYPDRIV_ANALYTICS", "dataset": "shop_events" }] }';

  it('lists what the configuration defines', async () => {
    const p = tempProject({ 'package.json': '{"name":"x"}', 'hypdriv.config.ts': config });
    const io = memoryIO(p.dir);
    expect(await runCommand('experiments', [], io)).toBe(0);
    expect(io.out).toContain('checkout');
    expect(io.out).toContain('control* 50% · b 50%');
    expect(io.out).toContain('80%');
    expect(io.out).toContain('concluded → c');
    expect(io.out).not.toContain('banner');
    const json = memoryIO(p.dir);
    await runCommand('experiments', ['--json'], json);
    const out = JSON.parse(json.out);
    expect(out.experiments.map((e: { name: string }) => e.name)).toEqual(['checkout', 'hero']);
    expect(out.experiments[0]).toMatchObject({
      control: 'control',
      traffic: 80,
      audience: true,
      status: 'running',
    });
    expect(out.experiments[1]).toMatchObject({ winner: 'c', control: 'a' });
  });

  it('says so when there are none, and rejects an unknown name', async () => {
    const p = tempProject({ 'package.json': '{"name":"x"}', 'hypdriv.config.ts': 'export default {};\n' });
    const io = memoryIO(p.dir);
    expect(await runCommand('experiments', [], io)).toBe(0);
    expect(io.out).toContain('None defined');
    const named = tempProject({ 'package.json': '{"name":"x"}', 'hypdriv.config.ts': config });
    const bad = memoryIO(named.dir);
    expect(await runCommand('experiments', ['--name', 'nope'], bad)).toBe(1);
    expect(bad.err).toContain('No experiment named "nope"');
    const results = memoryIO(p.dir);
    expect(await runCommand('experiments', ['--results'], results)).toBe(1);
    expect(results.err).toContain('No experiments defined');
  });

  it('derives the control from the flag default', () => {
    const list = configuredExperiments({
      x: { default: 'zzz', experiment: { variants: { a: 1, b: 1 } } },
      y: { default: false },
    });
    expect(list.map((e) => [e.name, e.control])).toEqual([['x', 'a']]);
  });

  it('prints the SQL without credentials', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': config,
      'wrangler.jsonc': wrangler,
    });
    const io = memoryIO(p.dir);
    expect(await runCommand('experiments', ['--sql', '--name', 'checkout', '--days', '30'], io)).toBe(0);
    expect(io.out).toContain("blob1 = 'experiment.exposure'");
    expect(io.out).toContain("INTERVAL '30' DAY");
    expect(io.out).toContain("position('|checkout:b|' IN blob8) > 0");
    expect(io.out).toContain('FROM shop_events');
  });

  it('queries visitors per variant and p75 vitals, and flags a sample ratio mismatch', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': config,
      'wrangler.jsonc': wrangler,
    });
    const { fetch, calls } = fakeFetch((_url, init) => {
      const sql = String(init?.body ?? '');
      if (sql.includes('experiment.exposure')) {
        return response(
          JSON.stringify({
            data: [
              {
                experiment: 'checkout',
                variant: 'control',
                visitors: 6200,
                first_seen: '2026-10-20 00:00:00',
                last_seen: '2026-10-31 12:00:00',
              },
              {
                experiment: 'checkout',
                variant: 'b',
                visitors: 3800,
                first_seen: '2026-10-20 00:00:00',
                last_seen: '2026-10-31 12:00:00',
              },
            ],
          }),
        );
      }
      const b = sql.includes('|checkout:b|');
      return response(
        JSON.stringify({
          data: [
            { metric: 'LCP', p75: b ? 1800 : 2000, samples: 3000 },
            { metric: 'CLS', p75: 0.04, samples: 3000 },
          ],
        }),
      );
    });
    const env = { CF_ACCOUNT_ID: 'acc123', CF_API_TOKEN: 'tok' };
    const io = memoryIO(p.dir, { fetch, env });
    expect(await runCommand('experiments', ['--results', '--name', 'checkout'], io)).toBe(1);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql');
    expect(calls).toHaveLength(3);
    expect(io.out).toContain('control (control)');
    expect(io.out).toContain('6200');
    expect(io.out).toContain('1.80 s');
    expect(io.out).toContain('−10.0%');
    expect(io.out).toContain('Sample ratio mismatch');

    const json = memoryIO(p.dir, { fetch, env });
    // The exit code does not depend on the output format: a pipeline reads it (ADR 0022).
    expect(await runCommand('experiments', ['--results', '--json', '--name', 'checkout'], json)).toBe(1);
    const report = JSON.parse(json.out).experiments[0];
    expect(report.visitors).toBe(10_000);
    expect(report.sampleRatio.status).toBe('mismatch');
    expect(report.variants[1].metrics.LCP.deltaVsControl).toBeCloseTo(-0.1);
  });

  it('does not flag a split chance explains, as JSON or text, and exits 0', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': config,
      'wrangler.jsonc': wrangler,
    });
    const { fetch } = fakeFetch((_url, init) =>
      String(init?.body ?? '').includes('experiment.exposure')
        ? response(
            JSON.stringify({
              data: [
                { experiment: 'checkout', variant: 'control', visitors: 5040 },
                { experiment: 'checkout', variant: 'b', visitors: 4960 },
              ],
            }),
          )
        : response(JSON.stringify({ data: [] })),
    );
    const env = { CF_ACCOUNT_ID: 'acc123', CF_API_TOKEN: 'tok' };
    const json = memoryIO(p.dir, { fetch, env });
    expect(await runCommand('experiments', ['--results', '--json', '--name', 'checkout'], json)).toBe(0);
    expect(JSON.parse(json.out).experiments[0].sampleRatio).toMatchObject({
      status: 'ok',
      method: 'chi-square',
    });
    const text = memoryIO(p.dir, { fetch, env });
    expect(await runCommand('experiments', ['--results', '--name', 'checkout'], text)).toBe(0);
    expect(text.out).toContain('Sample ratio ok');
  });

  it('judges a rare variant with the exact test, not chi-square (finding 8)', async () => {
    const rare = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts':
        "export default { flags: { definitions: { rare: { default: 'control', experiment: { variants: { control: 99, b: 1 } } } } } };\n",
      'wrangler.jsonc': wrangler,
    });
    const { fetch } = fakeFetch((_url, init) =>
      String(init?.body ?? '').includes('experiment.exposure')
        ? response(
            JSON.stringify({
              data: [
                { experiment: 'rare', variant: 'control', visitors: 95 },
                { experiment: 'rare', variant: 'b', visitors: 5 },
              ],
            }),
          )
        : response(JSON.stringify({ data: [] })),
    );
    const io = memoryIO(rare.dir, { fetch, env: { CF_ACCOUNT_ID: 'acc123', CF_API_TOKEN: 'tok' } });
    expect(await runCommand('experiments', ['--results', '--json'], io)).toBe(0);
    const sampleRatio = JSON.parse(io.out).experiments[0].sampleRatio;
    expect(sampleRatio).toMatchObject({ status: 'ok', method: 'exact' });
    expect(sampleRatio.p).toBeCloseTo(0.0034, 3);
  });

  it('starts the window at --since, for a ramp (finding 8)', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': config,
      'wrangler.jsonc': wrangler,
    });
    const io = memoryIO(p.dir, { date: () => new Date('2026-11-01T12:00:00Z') });
    expect(
      await runCommand('experiments', ['--sql', '--name', 'checkout', '--since', '2026-10-30T14:00:00Z'], io),
    ).toBe(0);
    expect(io.out).toContain("timestamp >= toDateTime('2026-10-30 14:00:00')");
    expect(io.out).not.toContain('INTERVAL');
    const relative = memoryIO(p.dir, { date: () => new Date('2026-11-01T12:00:00Z') });
    await runCommand('experiments', ['--sql', '--name', 'checkout', '--since', '36h'], relative);
    expect(relative.out).toContain("timestamp >= toDateTime('2026-10-31 00:00:00')");
    const bad = memoryIO(p.dir);
    expect(await runCommand('experiments', ['--sql', '--since', 'yesterday'], bad)).toBe(2);
    expect(bad.err).toContain('--since');
  });

  it('reads --since as UTC, a duration or a date, and refuses the future and the far past', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    expect(parseSince('2026-10-30', now).toISOString()).toBe('2026-10-30T00:00:00.000Z');
    expect(parseSince('2026-10-30T14:00', now).toISOString()).toBe('2026-10-30T14:00:00.000Z');
    expect(parseSince('2026-10-30 14:00:00', now).toISOString()).toBe('2026-10-30T14:00:00.000Z');
    expect(parseSince('2026-10-30T14:00:00+02:00', now).toISOString()).toBe('2026-10-30T12:00:00.000Z');
    expect(parseSince('3d', now).toISOString()).toBe('2026-10-29T12:00:00.000Z');
    expect(() => parseSince('2026-11-02', now)).toThrow(/future/);
    expect(() => parseSince('2026-06-01', now)).toThrow(/90 days/);
    expect(() => parseSince("2026-10-30'; DROP", now)).toThrow(/neither/);
    expect(() => parseSince('2026-13-45', now)).toThrow(/not a valid date/);
  });

  it('degrades clearly without credentials, a dataset or on Vercel', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': config,
      'wrangler.jsonc': wrangler,
    });
    const io = memoryIO(p.dir);
    expect(await runCommand('experiments', ['--results'], io)).toBe(1);
    expect(io.err).toContain('CF_ACCOUNT_ID and CF_API_TOKEN');
    const none = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': config,
      'wrangler.jsonc': '{}',
    });
    const io2 = memoryIO(none.dir);
    expect(await runCommand('experiments', ['--results'], io2)).toBe(1);
    expect(io2.err).toContain('No Analytics Engine dataset');
    const vercel = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': config,
      'vercel.json': '{}',
    });
    const io3 = memoryIO(vercel.dir);
    expect(await runCommand('experiments', ['--results'], io3)).toBe(1);
    expect(io3.err).toContain('experiment exposure');
  });
});

describe('manifest-aware css guard', () => {
  it('css commands fail clearly when Purser is disabled', async () => {
    const p = tempProject({
      'package.json': '{"name":"x"}',
      'hypdriv.config.ts': 'export default { purser: false };\n',
    });
    await writeManifest(p.dir, await fixtureManifest());
    const io = memoryIO(p.dir);
    expect(await runCommand('css', ['build'], io)).toBe(1);
    expect(io.err).toContain('Purser is disabled');
    expect(await runCommand('css', ['nope'], memoryIO(p.dir))).toBe(2);
  });
});
