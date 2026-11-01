import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findWorkerEntry, rwsdkVersion, wranglerMain } from './entry';

const created: string[] = [];

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-rwsdk-entry-'));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

const posix = (path: string) => path.split('\\').join('/');

describe('wranglerMain', () => {
  it('reads main from wrangler.jsonc, with comments and trailing commas', () => {
    const root = project({
      'wrangler.jsonc': `{
  // the Worker
  "name": "app",
  "main": "src/server.tsx", /* RedwoodSDK builds this */
  "compatibility_flags": ["nodejs_compat",],
}`,
    });
    expect(wranglerMain(root, {})).toBe(resolve(root, 'src/server.tsx'));
  });

  it('reads wrangler.json and wrangler.toml, in that order of preference after jsonc', () => {
    expect(wranglerMain(project({ 'wrangler.json': '{ "main": "./worker/index.ts" }' }), {})).toBeTruthy();
    const toml = project({
      'wrangler.toml': 'name = "app"\nmain = "src/edge.ts"\ncompatibility_date = "2026-01-01"\n',
    });
    expect(wranglerMain(toml, {})).toBe(resolve(toml, 'src/edge.ts'));
    const both = project({
      'wrangler.jsonc': '{ "main": "src/a.tsx" }',
      'wrangler.toml': 'main = "src/b.tsx"\n',
    });
    expect(wranglerMain(both, {})).toBe(resolve(both, 'src/a.tsx'));
  });

  it('follows RWSDK_WRANGLER_CONFIG, relative to the project or absolute, like RedwoodSDK does', () => {
    const root = project({
      'wrangler.jsonc': '{ "main": "src/a.tsx" }',
      'config/wrangler.test.jsonc': '{ "main": "../src/test.tsx" }',
    });
    expect(wranglerMain(root, { RWSDK_WRANGLER_CONFIG: 'config/wrangler.test.jsonc' })).toBe(
      resolve(root, 'src/test.tsx'),
    );
    expect(wranglerMain(root, { RWSDK_WRANGLER_CONFIG: join(root, 'config/wrangler.test.jsonc') })).toBe(
      resolve(root, 'src/test.tsx'),
    );
    // A named config that does not exist is not replaced by another.
    expect(wranglerMain(root, { RWSDK_WRANGLER_CONFIG: 'nope.jsonc' })).toBeNull();
  });

  it('returns null without a config, without main or with a config it cannot read', () => {
    expect(wranglerMain(project(), {})).toBeNull();
    expect(wranglerMain(project({ 'wrangler.jsonc': '{ "name": "app" }' }), {})).toBeNull();
    expect(wranglerMain(project({ 'wrangler.jsonc': '{ nope' }), {})).toBeNull();
  });
});

describe('findWorkerEntry', () => {
  it('prefers the plugin option, then the Wrangler main, then src/worker.*', () => {
    const root = project({
      'wrangler.jsonc': '{ "main": "src/server.tsx" }',
      'src/worker.tsx': '',
    });
    expect(findWorkerEntry(root, 'src/custom.tsx', {})).toBe(posix(resolve(root, 'src/custom.tsx')));
    expect(findWorkerEntry(root, undefined, {})).toBe(posix(resolve(root, 'src/server.tsx')));
    const plain = project({ 'src/worker.ts': '' });
    expect(findWorkerEntry(plain, undefined, {})).toBe(posix(join(plain, 'src/worker.ts')));
  });

  it('looks for src/worker.tsx, .ts, .jsx and .js in that order, and defaults to the first', () => {
    expect(findWorkerEntry(project({ 'src/worker.js': '', 'src/worker.jsx': '' }), undefined, {})).toMatch(
      /src\/worker\.jsx$/,
    );
    const none = project();
    expect(findWorkerEntry(none, undefined, {})).toBe(posix(join(none, 'src/worker.tsx')));
  });

  it('always answers with forward slashes, absolute', () => {
    const root = project();
    const path = findWorkerEntry(root, 'src\\worker.tsx', {});
    expect(path).not.toContain('\\');
    expect(path.startsWith('/')).toBe(true);
  });
});

describe('rwsdkVersion', () => {
  it('reads the installed version from node_modules, here or in a parent directory', () => {
    const root = project({
      'node_modules/rwsdk/package.json': JSON.stringify({ name: 'rwsdk', version: '1.2.3' }),
      'apps/web/package.json': '{}',
    });
    expect(rwsdkVersion(root)).toBe('1.2.3');
    expect(rwsdkVersion(join(root, 'apps/web'))).toBe('1.2.3');
  });

  it('answers unknown when it is not installed or the manifest is unreadable', () => {
    expect(rwsdkVersion(project())).not.toMatch(/^\d/);
    expect(rwsdkVersion(project({ 'node_modules/rwsdk/package.json': '{ nope' }))).toBe('unknown');
    expect(rwsdkVersion(project({ 'node_modules/rwsdk/package.json': '{}' }))).toBe('unknown');
  });

  it('finds the version this repository tests against', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(rwsdkVersion(resolve(here, '..'))).toMatch(/^1\.\d+\.\d+/);
  });
});
