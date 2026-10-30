import { writeManifest } from '@hypdriv/core/node';
import { verifyInternalRequest } from '@hypdriv/security';
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
