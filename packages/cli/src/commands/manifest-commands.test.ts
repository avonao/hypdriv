import { readFileSync, utimesSync } from 'node:fs';
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
import { renderBudgetMarkdown } from './budget';
import { hashEntries, readReports } from './csp';
import { validateManifest } from './manifest';
import { routeRows } from './routes';

let manifest: HypManifest;
let project: TempProject;

beforeAll(async () => {
  manifest = await fixtureManifest({
    cache: { edge: { policies: [{ id: 'blog', match: '/blog/**', ttl: '5m', swr: '1h', tags: ['blog'] }] } },
    budgets: { routes: { '/**': { js: '1kb' } } },
  });
  project = tempProject({
    'package.json': JSON.stringify({ name: 'fixture-app' }),
    'hypdriv.config.ts':
      "export default { cache: { edge: { policies: [{ id: 'blog', match: '/blog/**', ttl: '5m', swr: '1h', tags: ['blog'] }] } }, budgets: { routes: { '/**': { js: '1kb' } }, failOn: 'error' }, security: { csp: { allow: { images: ['https://images.example.com'] } } } };\n",
  });
  await writeManifest(project.dir, manifest);
});
afterAll(cleanupProjects);

async function run(name: string, args: string[]) {
  const io = memoryIO(project.dir);
  const code = await runCommand(name, args, io);
  return { code, io };
}

describe('routes', () => {
  it('derives rows with classification, policy, CSP mode, hints and weights', () => {
    const rows = routeRows(manifest);
    const byRoute = Object.fromEntries(rows.map((r) => [r.route, r]));
    expect(byRoute['/']).toMatchObject({
      classification: 'static',
      cachePolicy: 'inferred:app:/',
      csp: 'hash',
    });
    expect(byRoute['/blog/[slug]']).toMatchObject({
      classification: 'isr',
      revalidate: 60,
      cachePolicy: 'blog',
      csp: 'nonce',
      prerenderedPaths: 2,
    });
    expect(byRoute['/dashboard']).toMatchObject({
      classification: 'dynamic',
      cachePolicy: null,
      csp: 'nonce',
    });
    expect(byRoute['/api/hello']).toMatchObject({ classification: 'route', csp: 'none', js: null });
    expect(byRoute['/']!.hints).toBeGreaterThan(0);
    expect(byRoute['/']!.js).toBeGreaterThan(1000);
    expect(byRoute['/_not-found']).toBeUndefined();
    expect(routeRows(manifest, { all: true }).some((r) => r.route === '/_not-found')).toBe(true);
  });

  it('prints a table and JSON', async () => {
    const text = await run('routes', ['--cache', '--csp']);
    expect(text.code).toBe(0);
    expect(text.io.out).toContain('/blog/[slug]');
    expect(text.io.out).toContain('isr (2)');
    expect(text.io.out).toContain('300s/3600s [blog]');
    const json = await run('routes', ['--json', '--css']);
    const out = JSON.parse(json.io.out);
    expect(out.buildId).toBe('I1wNd3pCoOLr16ruV6B_d');
    expect(out.routes.find((r: { route: string }) => r.route === '/')).toMatchObject({
      csp: 'hash',
      atoms: null,
    });
  });
});

describe('manifest', () => {
  it('validates the fixture manifest and reports cross-check errors', () => {
    expect(validateManifest(manifest).filter((i) => i.level === 'error')).toEqual([]);
    const broken = structuredClone(manifest) as HypManifest;
    broken.routes.push({ ...broken.routes[0]! });
    broken.csp['app:/']!.scriptHashes.push('sha256-unquoted');
    broken.earlyHints['app:/'] = ['not a link'];
    broken.routes[1]!.regex = '([';
    broken.routes[1]!.dynamic = true;
    const issues = validateManifest(broken).map((i) => i.message);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate route id app:/'),
        'malformed hash source sha256-unquoted',
        'unparseable Link value "not a link"',
        expect.stringContaining('invalid regex'),
      ]),
    );
    expect(validateManifest({ version: 2 })[0]?.message).toMatch(/unsupported manifest version/);
  });

  it('prints, summarises and validates through the command', async () => {
    const full = await run('manifest', []);
    expect(JSON.parse(full.io.out).buildId).toBe(manifest.buildId);
    const summary = await run('manifest', ['--summary', '--json']);
    expect(JSON.parse(summary.io.out)).toMatchObject({
      buildId: manifest.buildId,
      routes: manifest.routes.length,
      classifications: { static: expect.any(Number) },
    });
    const valid = await run('manifest', ['--validate', '--json']);
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.io.out).valid).toBe(true);
  });
});

describe('budget', () => {
  it('evaluates budgets, fails --ci, stores snapshots and diffs', async () => {
    const ci = await run('budget', ['--ci', '--json']);
    const out = JSON.parse(ci.io.out);
    expect(out.failOn).toBe('error');
    expect(out.budgets.some((b: { status: string }) => b.status === 'error')).toBe(true);
    expect(ci.code).toBe(1);
    expect((await run('budget', ['--json'])).code).toBe(0);

    // previous snapshot with smaller weights
    const previous = structuredClone(manifest);
    previous.buildId = 'previous-build';
    for (const w of Object.values(previous.weights.client)) w.js -= 100;
    const dir = join(project.dir, '.hypdriv/snapshots');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'previous-build.json'),
      JSON.stringify({
        version: 1,
        buildId: 'previous-build',
        generatedAt: '2026-10-01T00:00:00Z',
        weights: previous.weights,
        budgets: [],
      }),
    );
    utimesSync(join(dir, 'previous-build.json'), new Date('2026-10-01'), new Date('2026-10-01'));
    const diff = await run('budget', ['--snapshot', '--diff', '--json']);
    const d = JSON.parse(diff.io.out);
    expect(d.previousBuildId).toBe('previous-build');
    expect(d.diff.find((x: { route: string }) => x.route === 'app:/').jsDelta).toBe(100);
    expect(JSON.parse(readFileSync(join(dir, `${manifest.buildId}.json`), 'utf8')).buildId).toBe(
      manifest.buildId,
    );
    const md = await run('budget', ['--diff', '--markdown']);
    expect(md.io.out).toContain('### HypDriv budgets');
    expect(md.io.out).toContain('| `route:app:/:js` |');
    expect(md.io.out).toContain('+100 B');
  });

  it('renders Markdown without budgets', () => {
    expect(
      renderBudgetMarkdown({
        buildId: 'b',
        budgets: [],
        diff: null,
        worker: { raw: 2000, gzip: 1000 },
        previousWorker: { raw: 1000, gzip: 1000 },
        previousBuildId: null,
      }),
    ).toContain('Worker: 2.0 kB raw · 1.0 kB gzip (+1.00 kB raw, ±0 gzip)');
  });
});

describe('csp', () => {
  it('lists hashes per static route', async () => {
    const entries = hashEntries(manifest);
    expect(entries.find((e) => e.key === 'app:/')?.scriptHashes.length).toBeGreaterThan(2);
    const out = await run('csp', ['hashes', '--route', '/', '--json']);
    const routes = JSON.parse(out.io.out).routes as Array<{ route: string }>;
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((r) => r.route === '/')).toBe(true);
    const nonce = await run('csp', ['hashes', '--route', '/dashboard']);
    expect(nonce.io.out).toContain('uses nonces');
  });

  it('prints the effective policy in hash and nonce mode', async () => {
    const hash = await run('csp', ['print', '--route', '/', '--json']);
    const h = JSON.parse(hash.io.out);
    expect(h.mode).toBe('hash');
    expect(h.policy).toContain("'sha256-");
    expect(h.policy).toContain('img-src');
    expect(h.policy).toContain('https://images.example.com');
    const nonce = await run('csp', ['print', '--route', '/blog/hello-world', '--json']);
    const n = JSON.parse(nonce.io.out);
    expect(n.mode).toBe('nonce');
    expect(n.policy).toContain("'nonce-NONCE_PLACEHOLDER'");
    expect(n.policy).toContain("'strict-dynamic'");
    const dev = await run('csp', [
      'print',
      '--route',
      '/dashboard',
      '--dev',
      '--origin',
      'http://localhost:3000',
    ]);
    expect(dev.io.out).toContain("'unsafe-eval'");
    expect(dev.io.out).toContain('ws://localhost:3000');
  });

  it('suggests allow-list additions from NDJSON reports', async () => {
    const reports = [
      {
        'csp-report': {
          'document-uri': 'https://shop.test/',
          'violated-directive': 'script-src-elem',
          'effective-directive': 'script-src-elem',
          'blocked-uri': 'https://js.stripe.com/v3/',
        },
      },
      {
        documentUri: 'https://shop.test/a',
        violatedDirective: 'img-src',
        effectiveDirective: 'img-src',
        blockedUri: 'https://cdn.example.com/x.png',
        disposition: 'report',
        ts: 1,
      },
      {
        documentUri: 'https://shop.test/b',
        violatedDirective: 'img-src',
        effectiveDirective: 'img-src',
        blockedUri: 'https://cdn.example.com/y.png',
        disposition: 'report',
        ts: 2,
      },
      { documentUri: 'https://shop.test/', effectiveDirective: 'script-src', blockedUri: 'inline' },
    ];
    project.write('reports.ndjson', `${reports.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`);
    const { readReports: parse } = await import('./csp');
    expect(parse('{"effectiveDirective":"img-src","blockedUri":"https://a.test/x"}').reports).toHaveLength(1);
    expect(readReports('garbage').invalid).toBe(1);
    const out = await run('csp', ['suggest', '--reports', 'reports.ndjson', '--json']);
    const s = JSON.parse(out.io.out);
    expect(s.invalid).toBe(1);
    expect(s.additions).toEqual(
      expect.arrayContaining([
        { directive: 'img-src', source: 'https://cdn.example.com', count: 2 },
        { directive: 'script-src', source: 'https://js.stripe.com', count: 1 },
      ]),
    );
    const text = await run('csp', ['suggest', '--reports', 'reports.ndjson']);
    expect(text.io.out).toContain("images: ['https://cdn.example.com']");
  });

  it('rejects unknown subcommands with exit code 2', async () => {
    const r = await run('csp', ['nope']);
    expect(r.code).toBe(2);
    expect(r.io.err).toContain('csp needs a subcommand');
  });
});

describe('agent', () => {
  it('prints a Markdown briefing and JSON', async () => {
    const md = await run('agent', []);
    expect(md.io.out).toContain('# HypDriv briefing — fixture-app');
    expect(md.io.out).toContain('## Commands');
    expect(md.io.out).toContain('edge cache: 1 explicit policy (blog)');
    const json = await run('agent', ['--json']);
    const b = JSON.parse(json.io.out);
    expect(b.build).toMatchObject({ manifest: true, buildId: manifest.buildId });
    expect(b.issues).toContain('next.config is not wrapped in withHypDriv() → run `hypdriv init`.');
  });
});

describe('without a manifest', () => {
  it('explains how to produce one', async () => {
    const empty = tempProject({ 'package.json': '{"name":"x"}' });
    const io = memoryIO(empty.dir);
    expect(await runCommand('routes', [], io)).toBe(1);
    expect(io.err).toContain('Run `next build`');
    const json = memoryIO(empty.dir);
    expect(await runCommand('routes', ['--json'], json)).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('manifest') },
    });
  });
});
