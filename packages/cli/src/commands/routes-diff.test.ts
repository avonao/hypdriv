import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HypManifest } from '@hypdriv/core';
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
import { diffFails, diffRoutes, loadBaseline } from './routes-diff';

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
    const current = clone(baseline);
    const missing = current.routes.find((r) => r.pathname === '/_not-found');
    if (missing) {
      missing.classification = 'dynamic';
      expect(diffRoutes(baseline, current).changes.some((c) => c.route === '/_not-found')).toBe(false);
      expect(
        diffRoutes(baseline, current, { all: true }).changes.some((c) => c.route === '/_not-found'),
      ).toBe(missing.classification !== baseline.routes.find((r) => r.id === missing.id)?.classification);
    }
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
    expect(await runCommand('routes', ['--diff', 'missing.json'], missing)).toBe(1);
    expect(missing.err).toContain('not found');
  });
});
