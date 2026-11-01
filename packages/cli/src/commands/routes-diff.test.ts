import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HypManifest, routeId } from '@hypdriv/core';
import { writeManifest } from '@hypdriv/core/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupProjects,
  fixtureManifest,
  memoryIO,
  type TempProject,
  tempProject,
} from '../__tests__/helpers';
import { runCommand } from '../main';
import { BASELINE_ERROR_EXIT, diffFails, diffRoutes, loadBaseline } from './routes-diff';

let baseline: HypManifest;
let project: TempProject;

const clone = <T>(value: T): T => structuredClone(value);

function route(m: HypManifest, pathname: string) {
  const found = m.routes.find((r) => r.pathname === pathname);
  if (!found) throw new Error(`fixture has no route ${pathname}`);
  return found;
}

beforeAll(async () => {
  baseline = await fixtureManifest({});
  project = tempProject({
    'package.json': JSON.stringify({ name: 'fixture-app' }),
    'hypdriv.config.ts': 'export default {};\n',
  });
});
afterAll(cleanupProjects);

describe('diffRoutes()', () => {
  it('reports no changes for identical manifests', () => {
    const diff = diffRoutes(baseline, clone(baseline));
    expect(diff.changes).toEqual([]);
    expect(diff.summary.regressions).toBe(0);
    expect(diff.summary.unchanged).toBeGreaterThan(0);
  });

  it('flags a prerendered route that became dynamic as one regression (the CSP mode follows from it)', () => {
    const current = clone(baseline);
    const home = route(current, '/');
    expect(home.classification).toBe('static');
    home.classification = 'dynamic';
    delete home.prerender;
    const diff = diffRoutes(baseline, current);
    const change = diff.changes.find((c) => c.route === '/' && c.kind === 'classification');
    expect(change).toMatchObject({ severity: 'regression', from: 'static', to: 'dynamic' });
    expect(change?.note).toContain('dynamic API');
    expect(diff.changes.filter((c) => c.route === '/')).toHaveLength(1);
    expect(diff.summary.regressions).toBe(1);
  });

  it('flags a static route that lost its hash policy on its own', () => {
    const current = clone(baseline);
    const home = route(current, '/');
    delete current.csp[home.id];
    const diff = diffRoutes(baseline, current);
    expect(diff.changes).toEqual([
      expect.objectContaining({ route: '/', kind: 'csp', severity: 'regression', from: 'hash', to: 'nonce' }),
    ]);
    expect(diffRoutes(current, baseline).changes.find((c) => c.kind === 'csp')).toMatchObject({
      severity: 'improvement',
      from: 'nonce',
      to: 'hash',
    });
  });

  it('names the ensureStatic guard when a guarded route regresses', () => {
    const current = clone(baseline);
    const home = route(current, '/');
    home.classification = 'shell';
    home.ensureStatic = 'navigation';
    const change = diffRoutes(baseline, current).changes.find((c) => c.kind === 'classification');
    expect(change?.note).toContain("ensureStatic: 'navigation'");
  });

  it('reports the reverse direction as an improvement', () => {
    const current = clone(baseline);
    const dashboard = route(baseline, '/dashboard');
    expect(dashboard.classification).toBe('dynamic');
    const worse = clone(baseline);
    route(worse, '/blog/[slug]').classification = 'dynamic';
    const diff = diffRoutes(worse, current);
    expect(diff.changes.find((c) => c.route === '/blog/[slug]' && c.kind === 'classification')).toMatchObject(
      {
        severity: 'improvement',
        from: 'dynamic',
        to: 'isr',
      },
    );
    expect(diff.summary.improvements).toBeGreaterThan(0);
    expect(diff.summary.regressions).toBe(0);
  });

  it('reports added and removed routes as information', () => {
    const current = clone(baseline);
    const extra = clone(route(current, '/dashboard'));
    extra.id = `${extra.id}-new`;
    extra.pathname = '/reports';
    current.routes.push(extra);
    current.routes = current.routes.filter((r) => r.pathname !== '/dashboard');
    const diff = diffRoutes(baseline, current);
    expect(diff.changes.find((c) => c.kind === 'added')).toMatchObject({
      route: '/reports',
      severity: 'info',
    });
    expect(diff.changes.find((c) => c.kind === 'removed')).toMatchObject({
      route: '/dashboard',
      severity: 'info',
    });
    expect(diff.summary).toMatchObject({ added: 1, removed: 1, regressions: 0 });
  });

  it('flags a dropped cache policy and vanished prerendered paths', () => {
    const current = clone(baseline);
    const blog = route(current, '/blog/[slug]');
    delete blog.cachePolicyId;
    blog.prerender = { ...blog.prerender!, paths: [], pathCount: 0 };
    const diff = diffRoutes(baseline, current);
    expect(diff.changes.find((c) => c.kind === 'cache-policy')).toMatchObject({ severity: 'regression' });
    expect(diff.changes.find((c) => c.kind === 'prerendered-paths')).toMatchObject({
      severity: 'regression',
      from: '2',
      to: '0',
    });
  });

  it('reports a revalidate change as information', () => {
    const current = clone(baseline);
    route(current, '/blog/[slug]').prerender = {
      ...route(baseline, '/blog/[slug]').prerender!,
      revalidate: 30,
    };
    expect(diffRoutes(baseline, current).changes.find((c) => c.kind === 'revalidate')).toMatchObject({
      severity: 'info',
      from: '60s',
      to: '30s',
    });
  });

  it('compares client weights only on request, and only past the threshold', () => {
    const current = clone(baseline);
    const home = route(current, '/');
    const weight = current.weights.client[home.id]!;
    weight.js += Math.ceil(weight.js * 0.5) + 2048;
    expect(diffRoutes(baseline, current).changes.some((c) => c.kind === 'js-weight')).toBe(false);
    const diff = diffRoutes(baseline, current, { weights: true });
    expect(diff.changes.find((c) => c.kind === 'js-weight')).toMatchObject({ severity: 'regression' });
    expect(diffRoutes(baseline, current, { weights: true, weightThreshold: 5000 }).changes).toEqual([]);
    weight.js = baseline.weights.client[home.id]!.js + 10;
    expect(diffRoutes(baseline, current, { weights: true }).changes).toEqual([]);
  });

  it('hides _not-found unless asked', () => {
    const before = clone(baseline);
    const home = route(before, '/');
    before.routes = before.routes.filter((r) => r.pathname !== '/_not-found');
    before.routes.push({ ...clone(home), id: `${home.id}-nf`, pathname: '/_not-found' });
    const current = clone(before);
    route(current, '/_not-found').classification = 'dynamic';
    expect(route(before, '/_not-found').classification).toBe('static');
    expect(diffRoutes(before, current).changes.some((c) => c.route === '/_not-found')).toBe(false);
    expect(diffRoutes(before, current, { all: true }).changes).toEqual([
      expect.objectContaining({ route: '/_not-found', kind: 'classification', severity: 'regression' }),
    ]);
  });

  it('pairs a route whose kind changed by its path instead of reporting an addition and a removal', () => {
    const current = clone(baseline);
    const dashboard = route(current, '/dashboard');
    dashboard.kind = 'app-route';
    dashboard.id = routeId('app-route', '/dashboard');
    const diff = diffRoutes(baseline, current);
    expect(diff.changes).toEqual([
      expect.objectContaining({ route: '/dashboard', kind: 'route-kind', severity: 'info' }),
    ]);
    expect(diff.summary).toMatchObject({ added: 0, removed: 0 });
    expect(diff.summary.matched).toBeGreaterThan(0);
  });

  it('counts the routes both builds share, none for an unrelated baseline', () => {
    const same = diffRoutes(baseline, clone(baseline));
    expect(same.summary.matched).toBe(same.summary.unchanged);
    const other = clone(baseline);
    for (const r of other.routes) {
      r.pathname = `/other${r.pathname === '/' ? '' : r.pathname}`;
      r.id = `${r.id}-other`;
    }
    expect(diffRoutes(baseline, other).summary.matched).toBe(0);
  });

  it('treats a revalidate that shrank by more than half as a regression, and a slower one as an improvement', () => {
    const slow = clone(baseline);
    const fast = clone(baseline);
    const blogSlow = route(slow, '/blog/[slug]');
    const blogFast = route(fast, '/blog/[slug]');
    blogSlow.prerender = { ...blogSlow.prerender!, revalidate: 3600 };
    blogFast.prerender = { ...blogFast.prerender!, revalidate: 1 };
    const worse = diffRoutes(slow, fast).changes.find((c) => c.kind === 'revalidate');
    expect(worse).toMatchObject({ severity: 'regression', from: '3600s', to: '1s' });
    expect(worse?.note).toContain('as often');
    expect(diffRoutes(fast, slow).changes.find((c) => c.kind === 'revalidate')).toMatchObject({
      severity: 'improvement',
    });
    blogFast.prerender = { ...blogFast.prerender!, revalidate: false };
    expect(diffRoutes(fast, slow).changes.find((c) => c.kind === 'revalidate')?.severity).toBe('regression');
  });

  it('treats most prerendered paths disappearing as a regression, but not a small drop', () => {
    const many = clone(baseline);
    const blog = route(many, '/blog/[slug]');
    blog.prerender = { ...blog.prerender!, pathCount: 100 };
    const few = clone(many);
    route(few, '/blog/[slug]').prerender = { ...blog.prerender!, pathCount: 1 };
    expect(diffRoutes(many, few).changes.find((c) => c.kind === 'prerendered-paths')).toMatchObject({
      severity: 'regression',
      from: '100',
      to: '1',
    });
    const some = clone(many);
    route(some, '/blog/[slug]').prerender = { ...blog.prerender!, pathCount: 70 };
    expect(diffRoutes(many, some).changes.find((c) => c.kind === 'prerendered-paths')?.severity).toBe('info');
  });
});

describe('diffFails()', () => {
  const regression = { changes: [{}], summary: { regressions: 1 } } as never;
  const info = { changes: [{}], summary: { regressions: 0 } } as never;
  const none = { changes: [], summary: { regressions: 0 } } as never;

  it('fails on regressions by default, on any change when asked, never when disabled', () => {
    expect([
      diffFails(regression, 'regress'),
      diffFails(info, 'regress'),
      diffFails(none, 'regress'),
    ]).toEqual([true, false, false]);
    expect([diffFails(regression, 'change'), diffFails(info, 'change'), diffFails(none, 'change')]).toEqual([
      true,
      true,
      false,
    ]);
    expect(diffFails(regression, 'never')).toBe(false);
  });
});

describe('loadBaseline()', () => {
  it('reads a manifest file and a directory holding .hypdriv/manifest.json', async () => {
    const dir = tempProject({ 'package.json': '{}' });
    await writeManifest(dir.dir, baseline);
    expect(loadBaseline(dir.dir, '/').buildId).toBe(baseline.buildId);
    expect(loadBaseline(join(dir.dir, '.hypdriv', 'manifest.json'), '/').buildId).toBe(baseline.buildId);
  });

  it('explains missing, malformed and foreign baselines', () => {
    const dir = tempProject({ 'broken.json': '{', 'other.json': '{"hello":"world"}' });
    expect(() => loadBaseline('nope.json', dir.dir)).toThrow(/not found/);
    expect(() => loadBaseline('broken.json', dir.dir)).toThrow(/not valid JSON/);
    expect(() => loadBaseline('other.json', dir.dir)).toThrow(/not a Hypdriv manifest/);
    expect(() => loadBaseline('.', dir.dir)).toThrow(/No manifest\.json/);
  });

  it('refuses an incomplete baseline with the baseline exit code instead of crashing in the diff', () => {
    const dir = tempProject({ 'package.json': '{}' });
    for (const field of ['csp', 'earlyHints', 'weights'] as const) {
      const partial = clone(baseline) as unknown as Record<string, unknown>;
      delete partial[field];
      writeFileSync(join(dir.dir, `no-${field}.json`), JSON.stringify(partial));
      let error: unknown;
      try {
        loadBaseline(`no-${field}.json`, dir.dir);
      } catch (err) {
        error = err;
      }
      expect(error).toMatchObject({
        exitCode: BASELINE_ERROR_EXIT,
        message: expect.stringContaining('incomplete'),
      });
    }
  });
});

describe('hypdriv routes --diff', () => {
  async function runDiff(current: HypManifest, extra: string[] = []) {
    await writeManifest(project.dir, current);
    writeFileSync(join(project.dir, 'baseline.json'), JSON.stringify(baseline));
    const io = memoryIO(project.dir);
    const code = await runCommand('routes', ['--diff', 'baseline.json', ...extra], io);
    return { code, io };
  }

  it('exits 0 and says so when nothing changed', async () => {
    const { code, io } = await runDiff(clone(baseline));
    expect(code).toBe(0);
    expect(io.out).toContain('No route changes');
  });

  it('exits 1 on a regression, printing the table and the explanation', async () => {
    const current = clone(baseline);
    route(current, '/').classification = 'dynamic';
    const { code, io } = await runDiff(current);
    expect(code).toBe(1);
    expect(io.out).toContain('Regressions (');
    expect(io.out).toContain('static');
    expect(io.out).toContain('dynamic');
    expect(io.out).toMatch(/1 regression,/);
  });

  it('honours --fail-on never and --fail-on change, in JSON too', async () => {
    const current = clone(baseline);
    route(current, '/').classification = 'dynamic';
    expect((await runDiff(current, ['--fail-on', 'never'])).code).toBe(0);
    const info = clone(baseline);
    route(info, '/blog/[slug]').prerender = { ...route(baseline, '/blog/[slug]').prerender!, revalidate: 30 };
    expect((await runDiff(info)).code).toBe(0);
    const strict = await runDiff(info, ['--fail-on', 'change', '--json']);
    expect(strict.code).toBe(1);
    const out = JSON.parse(strict.io.out);
    expect(out).toMatchObject({ failOn: 'change', failed: true, summary: { regressions: 0, info: 1 } });
    expect(out.baseline.buildId).toBe(baseline.buildId);
    expect(out.changes[0]).toMatchObject({ route: '/blog/[slug]', kind: 'revalidate' });
  });

  it('rejects an unknown --fail-on and a missing baseline', async () => {
    await writeManifest(project.dir, clone(baseline));
    const bad = await runCommand(
      'routes',
      ['--diff', 'baseline.json', '--fail-on', 'sometimes'],
      memoryIO(project.dir),
    );
    expect(bad).not.toBe(0);
    const missing = memoryIO(project.dir);
    expect(await runCommand('routes', ['--diff', 'missing.json'], missing)).toBe(2);
    expect(missing.err).toContain('not found');
  });

  it('exits 2, not 0, when the baseline shares no route with the build (and warns under --fail-on never)', async () => {
    const other = clone(baseline);
    for (const r of other.routes) {
      r.pathname = `/other${r.pathname === '/' ? '' : r.pathname}`;
      r.id = `${r.id}-other`;
    }
    await writeManifest(project.dir, other);
    writeFileSync(join(project.dir, 'baseline.json'), JSON.stringify(baseline));
    const io = memoryIO(project.dir);
    expect(await runCommand('routes', ['--diff', 'baseline.json'], io)).toBe(2);
    expect(io.err).toContain('share no route');
    const lenient = memoryIO(project.dir);
    expect(
      await runCommand('routes', ['--diff', 'baseline.json', '--fail-on', 'never', '--json'], lenient),
    ).toBe(0);
    expect(JSON.parse(lenient.out).warnings[0]).toContain('share no route');
  });

  it('exits 2 for an incomplete baseline and 1 for a regression, so a pipeline can tell them apart', async () => {
    await writeManifest(project.dir, clone(baseline));
    const partial = clone(baseline) as unknown as Record<string, unknown>;
    delete partial.weights;
    writeFileSync(join(project.dir, 'partial.json'), JSON.stringify(partial));
    const io = memoryIO(project.dir);
    expect(await runCommand('routes', ['--diff', 'partial.json'], io)).toBe(2);
    expect(io.err).toContain('incomplete');
  });
});
