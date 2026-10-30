import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyManifest } from '../manifest/types';
import {
  findConfigFile,
  findProjectRoot,
  importConfigModule,
  installedVersion,
  loadConfigFile,
  readManifestSync,
  readPackageJson,
  writeManifest,
} from './index';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hypdriv-core-node-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('config files', () => {
  it('returns defaults when no config file exists', async () => {
    const loaded = await loadConfigFile(dir);
    expect(loaded.file).toBeNull();
    expect(loaded.resolved.site.name).toBeTypeOf('string');
  });

  it('loads a TypeScript config with type annotations', async () => {
    writeFileSync(
      join(dir, 'hypdriv.config.ts'),
      [
        'interface Shape { site: { name: string } }',
        "const value: Shape = { site: { name: 'typed-app' } };",
        'export default value;',
      ].join('\n'),
    );
    expect(findConfigFile(dir)).toBe(join(dir, 'hypdriv.config.ts'));
    const loaded = await loadConfigFile(dir);
    expect(loaded.config).toEqual({ site: { name: 'typed-app' } });
    expect(loaded.resolved.site.name).toBe('typed-app');
    // No temporary files are left behind.
    expect(readdirSync(dir).filter((f) => f.endsWith('.mjs'))).toEqual([]);
  });

  it('accepts a named `config` export and an explicit file', async () => {
    const file = join(dir, 'custom.mjs');
    writeFileSync(file, "export const config = { site: { name: 'named' } };\n");
    const loaded = await loadConfigFile(dir, file);
    expect(loaded.file).toBe(file);
    expect(loaded.resolved.site.name).toBe('named');
  });

  it('re-imports a changed file', async () => {
    const file = join(dir, 'hypdriv.config.mjs');
    writeFileSync(file, "export default { site: { name: 'one' } };\n");
    expect((await importConfigModule<{ default: { site: { name: string } } }>(file)).default.site.name).toBe(
      'one',
    );
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(file, "export default { site: { name: 'two' } };\n");
    expect((await importConfigModule<{ default: { site: { name: string } } }>(file)).default.site.name).toBe(
      'two',
    );
  });

  it('surfaces syntax errors in JavaScript configs', async () => {
    const file = join(dir, 'hypdriv.config.mjs');
    writeFileSync(file, 'export default {;\n');
    await expect(importConfigModule(file)).rejects.toThrow();
  });
});

describe('project helpers', () => {
  it('finds the project root and reads package.json', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { next: '16.4.3' },
        packageManager: 'pnpm@12.16.1',
      }),
    );
    mkdirSync(join(dir, 'app', 'blog'), { recursive: true });
    expect(findProjectRoot(join(dir, 'app', 'blog'))).toBe(dir);
    const pkg = readPackageJson(dir);
    expect(pkg?.name).toBe('app');
    expect(pkg?.dependencies.next).toBe('16.4.3');
    expect(pkg?.packageManager).toBe('pnpm@12.16.1');
  });

  it('resolves installed versions through parent node_modules', () => {
    mkdirSync(join(dir, 'node_modules', 'next'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'next', 'package.json'), JSON.stringify({ version: '16.4.3' }));
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    expect(installedVersion(join(dir, 'apps', 'web'), 'next')).toBe('16.4.3');
    expect(installedVersion(dir, 'missing-package-xyz')).toBeNull();
  });

  it('writes and reads the manifest', async () => {
    const manifest = { ...emptyManifest(), buildId: 'build-1' };
    const { json, module } = await writeManifest(dir, manifest);
    expect(json.endsWith('manifest.json')).toBe(true);
    expect(module.endsWith('manifest.js')).toBe(true);
    expect(readManifestSync(dir)?.buildId).toBe('build-1');
  });
});
