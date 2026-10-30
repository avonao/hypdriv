import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, fakeFetch, memoryIO, response, tempProject } from '../__tests__/helpers';
import { runCommand } from '../main';
import { fetchPackageInfos } from './registry';
import { expandPatterns, parseWorkspaceYaml, readWorkspace } from './workspace';

afterEach(cleanupProjects);

const LATEST: Record<string, { latest: string; versions: string[] }> = {
  next: { latest: '16.5.1', versions: ['16.4.3', '16.5.0', '16.5.1', '17.0.0-canary.1'] },
  react: { latest: '19.3.1', versions: ['19.3.1'] },
  typescript: { latest: '7.0.2', versions: ['6.0.3', '7.0.2'] },
  vitest: { latest: '4.1.13', versions: ['4.1.12', '4.1.13'] },
  '@types/node': { latest: '26.7.0', versions: ['26.6.6', '26.7.0'] },
  '@typescript/typescript6': { latest: '6.0.4', versions: ['6.0.3', '6.0.4'] },
};

function registry() {
  return fakeFetch((url) => {
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    const entry = LATEST[name];
    if (!entry) return response('{"error":"Not found"}', { status: 404 });
    return response(
      JSON.stringify({
        name,
        'dist-tags': { latest: entry.latest },
        versions: Object.fromEntries(entry.versions.map((v) => [v, {}])),
        modified: '2026-10-29T00:00:00Z',
      }),
    );
  });
}

function workspace() {
  return tempProject({
    'package.json': JSON.stringify(
      { name: 'mono', private: true, devDependencies: { typescript: 'catalog:', vitest: 'catalog:' } },
      null,
      2,
    ),
    'pnpm-workspace.yaml': `packages:\n  - packages/*\n  - "!packages/ignored"\n\n# shared\ncatalog:\n  typescript: ^6.0.3\n  vitest: ^4.1.12 # test runner\n  "@types/node": ^26.6.6\n\ncatalogs:\n  legacy:\n    react: ^19.3.1\n`,
    'packages/app/package.json': JSON.stringify(
      {
        name: '@mono/app',
        dependencies: {
          next: '^16.4.3',
          react: 'catalog:legacy',
          '@mono/lib': 'workspace:*',
          ts6: 'npm:@typescript/typescript6@^6.0.3',
        },
        devDependencies: { '@types/node': 'catalog:' },
      },
      null,
      2,
    ),
    'packages/lib/package.json': JSON.stringify(
      { name: '@mono/lib', dependencies: { 'left-pad-unknown': '^1.0.0' } },
      null,
      2,
    ),
    'packages/ignored/package.json': JSON.stringify({ name: 'ignored', dependencies: { next: '1.0.0' } }),
  });
}

describe('workspace reading', () => {
  it('parses pnpm-workspace.yaml packages, catalogs and named catalogs', () => {
    const yaml = parseWorkspaceYaml(
      `packages:\n  - packages/*\n  - 'examples/*'\ncatalog:\n  next: ^16.4.3\n  "@scope/x": 1.0.0\ncatalogs:\n  react18:\n    react: ^18.3.1\n`,
    );
    expect(yaml.patterns).toEqual(['packages/*', 'examples/*']);
    expect(yaml.catalogs.default).toEqual({
      next: { range: '^16.4.3', line: 5 },
      '@scope/x': { range: '1.0.0', line: 6 },
    });
    expect(yaml.catalogs.react18).toEqual({ react: { range: '^18.3.1', line: 9 } });
  });

  it('expands patterns with negations and resolves catalog and alias specifiers', () => {
    const p = workspace();
    expect(expandPatterns(p.dir, ['packages/*', '!packages/ignored']).map((d) => d.split('/').pop())).toEqual(
      ['app', 'lib'],
    );
    const ws = readWorkspace(p.dir);
    expect(ws.packages.map((x) => x.path)).toEqual(['.', 'packages/app', 'packages/lib']);
    const app = ws.packages.find((x) => x.name === '@mono/app')!;
    expect(app.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'next', range: '^16.4.3', catalog: null }),
        expect.objectContaining({ name: 'react', range: '^19.3.1', catalog: 'legacy' }),
        expect.objectContaining({
          name: '@typescript/typescript6',
          range: '^6.0.3',
          alias: '@typescript/typescript6',
        }),
        expect.objectContaining({
          name: '@types/node',
          range: '^26.6.6',
          catalog: 'default',
          section: 'devDependencies',
        }),
      ]),
    );
    expect(app.dependencies.some((d) => d.name === '@mono/lib')).toBe(false);
  });

  it('looks packages up with bounded concurrency and reports errors', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const url = String(input);
      if (url.endsWith('missing')) return response('', { status: 404 });
      return response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }));
    }) as typeof fetch;
    const names = Array.from({ length: 20 }, (_, i) => `pkg${i}`).concat('missing');
    const infos = await fetchPackageInfos(names, { fetch: fetchImpl, concurrency: 8 });
    expect(peak).toBeLessThanOrEqual(8);
    expect(infos.get('pkg3')?.latest).toBe('1.0.0');
    expect(infos.get('missing')?.error).toBe('HTTP 404');
  });
});

describe('hypdriv deps', () => {
  it('prints the JSON report consumed by scripts/deps-summary.mjs', async () => {
    const p = workspace();
    const { fetch, calls } = registry();
    const io = memoryIO(p.dir, { fetch });
    const code = await runCommand('deps', ['--json'], io);
    expect(code).toBe(0);
    const report = JSON.parse(io.out);
    expect(typeof report.generatedAt).toBe('string');
    const byPkg = Object.fromEntries(report.packages.map((x: { name: string }) => [x.name, x]));
    expect(byPkg.mono.outdated).toEqual(
      expect.arrayContaining([
        {
          name: 'typescript',
          current: '^6.0.3',
          latest: '7.0.2',
          diff: 'major',
          dev: true,
          catalog: 'default',
          section: 'devDependencies',
          alias: null,
        },
        expect.objectContaining({
          name: 'vitest',
          current: '^4.1.12',
          latest: '4.1.13',
          diff: 'patch',
          dev: true,
        }),
      ]),
    );
    expect(byPkg['@mono/app'].outdated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'next',
          current: '^16.4.3',
          latest: '16.5.1',
          diff: 'minor',
          dev: false,
        }),
        expect.objectContaining({ name: '@types/node', diff: 'minor' }),
        expect.objectContaining({
          name: '@typescript/typescript6',
          diff: 'patch',
          alias: '@typescript/typescript6',
        }),
      ]),
    );
    expect(byPkg['@mono/app'].outdated.some((o: { name: string }) => o.name === 'react')).toBe(false);
    expect(report.errors['left-pad-unknown']).toBe('HTTP 404');
    expect(calls[0]!.headers.get('accept')).toContain('application/vnd.npm.install-v1+json');
    expect(calls.some((c) => c.url.endsWith('/@types%2Fnode'))).toBe(true);
  });

  it('applies safe updates to package.json and catalog lines, leaving majors alone', async () => {
    const p = workspace();
    const { fetch } = registry();
    const io = memoryIO(p.dir, { fetch });
    expect(await runCommand('deps', ['--update', 'safe'], io)).toBe(0);
    expect(io.out).toContain('pnpm install');
    const app = JSON.parse(p.read('packages/app/package.json'));
    expect(app.dependencies.next).toBe('^16.5.1');
    expect(app.dependencies.ts6).toBe('npm:@typescript/typescript6@^6.0.4');
    expect(app.devDependencies['@types/node']).toBe('catalog:');
    const yaml = p.read('pnpm-workspace.yaml');
    expect(yaml).toContain('  vitest: ^4.1.13 # test runner\n');
    expect(yaml).toContain('  "@types/node": ^26.7.0\n');
    expect(yaml).toContain('  typescript: ^6.0.3\n');
    expect(JSON.parse(p.read('package.json')).devDependencies.typescript).toBe('catalog:');
  });

  it('requires --only for major updates and supports --dry-run', async () => {
    const p = workspace();
    expect(await runCommand('deps', ['--update', 'major'], memoryIO(p.dir))).toBe(2);
    const { fetch } = registry();
    const io = memoryIO(p.dir, { fetch });
    expect(
      await runCommand('deps', ['--update', 'major', '--only', 'typescript', '--dry-run', '--json'], io),
    ).toBe(0);
    const out = JSON.parse(io.out);
    expect(out.update.changes).toEqual([
      { file: 'pnpm-workspace.yaml', name: 'typescript', from: '^6.0.3', to: '^7.0.2' },
    ]);
    expect(p.read('pnpm-workspace.yaml')).toContain('typescript: ^6.0.3');
  });
});
