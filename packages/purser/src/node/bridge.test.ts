import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HypDrivError, type ResolvedPurser, resolveConfig } from '@hypdriv/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFakeProject,
  type FakeProject,
  FIXTURE_CSS,
  fakePurserState,
  resetFakePurser,
} from './__fixtures__/project';
import {
  closeAllPurserWatchers,
  createPurserBridge,
  formatPurserDiagnostic,
  purserBuildOptions,
} from './bridge';
import type { PurserBuildResult } from './purser-types';

const projects: FakeProject[] = [];
const project = (...args: Parameters<typeof createFakeProject>) => {
  const p = createFakeProject(...args);
  projects.push(p);
  return p;
};
afterEach(async () => {
  await closeAllPurserWatchers();
  resetFakePurser();
  for (const p of projects.splice(0)) p.cleanup();
});

const purserConfig = (overrides: Record<string, unknown> = {}): ResolvedPurser =>
  resolveConfig({ purser: { ...overrides } }).purser!;

describe('createPurserBridge', () => {
  it('maps ResolvedPurser to BuildOptions and auto-detects the tokens module', async () => {
    const p = project({ files: { 'lib/tokens.ts': '' } });
    const bridge = await createPurserBridge({
      projectDir: p.dir,
      config: purserConfig({ prefix: 'p', salt: 's', cssModule: 'lib/css.ts', src: ['app', 'ui'] }),
    });
    expect(bridge.options).toEqual({
      projectDir: p.dir,
      src: ['app', 'ui'],
      tokens: 'lib/tokens.ts',
      out: 'app/purser.css',
      prefix: 'p',
      salt: 's',
      packageName: '@avonao/purser',
      cssModule: 'lib/css.ts',
      layers: { tokens: 'purser.tokens', globals: 'purser.globals', atoms: 'purser.atoms' },
    });
    expect(bridge.outFile).toBe(join(p.dir, 'app', 'purser.css'));
    expect(bridge.tokensFile).toBe(join(p.dir, 'lib', 'tokens.ts'));
    expect(bridge.detection.installed).toBe(true);
    expect(
      purserBuildOptions(
        '/root',
        purserConfig({ project: 'web', tokens: 'design/tokens.ts' }),
        'lib/tokens.ts',
      ),
    ).toMatchObject({ projectDir: join('/root', 'web'), tokens: 'design/tokens.ts' });
    expect(purserBuildOptions('/root', purserConfig(), null).tokens).toBeUndefined();
  });

  it('runs build() and check() through the host module', async () => {
    const p = project({ files: { 'lib/tokens.ts': '' } });
    const bridge = await createPurserBridge({ projectDir: p.dir, config: purserConfig() });
    const built = await bridge.build();
    expect(built.written).toBe(true);
    expect(readFileSync(join(p.dir, 'app/purser.css'), 'utf8')).toBe(FIXTURE_CSS);
    expect(await bridge.readStylesheet()).toBe(FIXTURE_CSS);
    const checked = await bridge.check();
    expect(checked.outFile).toBeNull();
    const calls = fakePurserState().calls;
    expect(calls.map((c) => c.method)).toEqual(['build', 'check']);
    expect(calls[0]!.options.out).toBe('app/purser.css');
    expect('out' in calls[1]!.options).toBe(false);
    expect(bridge.hasErrors(built)).toBe(false);
    expect(bridge.formatDiagnostics(built)).toBe('lib/tokens.ts:3:5: warning: axis "mode" is not exhaustive');
    expect(bridge.formatSummary(built)).toBe(
      'purser: wrote app/purser.css (2 files, 3 classes, 4 rules, 1 tokens, 1 keyframes)',
    );
    expect(bridge.formatSummary(checked)).toBe(
      'purser: ok (2 files, 3 classes, 4 rules, 1 tokens, 1 keyframes)',
    );
  });

  it('writes .hypdriv/dev/purser.json with project-relative paths', async () => {
    const p = project({ files: { 'lib/tokens.ts': '' } });
    const bridge = await createPurserBridge({ projectDir: p.dir, config: purserConfig() });
    fakePurserState().next = {
      css: null,
      written: false,
      diagnostics: [
        {
          severity: 'error',
          message: 'raw colour "#fff"',
          file: join(p.dir, 'components/button.tsx'),
          line: 9,
          column: 14,
        },
        { severity: 'error', message: 'self-check: !important found' },
      ],
    };
    const result = await bridge.build();
    const file = await bridge.writeDevDiagnostics(result);
    expect(file).toBe(join(p.dir, '.hypdriv', 'dev', 'purser.json'));
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          message: 'raw colour "#fff"',
          file: 'components/button.tsx',
          line: 9,
          column: 14,
        },
        { severity: 'error', message: 'self-check: !important found', file: null, line: null, column: null },
      ],
      stats: { files: 2, atoms: 3, rules: 4, keyframes: 1, tokens: 1 },
      outFile: 'app/purser.css',
      written: false,
      stylesheet: null,
      purser: { version: '0.1.0', typescript: '5.9.3' },
    });
    expect(typeof json.ts).toBe('string');
    expect(bridge.formatSummary(result)).toBe('purser: 2 errors; stylesheet not written');
    expect(bridge.hasErrors(result)).toBe(true);

    const ok = await bridge.writeDevDiagnostics(await bridge.build());
    const good = JSON.parse(readFileSync(ok, 'utf8')) as {
      ok: boolean;
      stylesheet: { atoms: number; hash: string; layers: string[]; bytes: number };
    };
    expect(good.ok).toBe(true);
    expect(good.stylesheet.atoms).toBe(3);
    expect(good.stylesheet.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(good.stylesheet.layers).toEqual(['purser.tokens', 'purser.globals', 'purser.atoms']);
    expect(good.stylesheet.bytes).toBe(Buffer.byteLength(FIXTURE_CSS));
  });

  it('shares one watcher per project and process, replaying the last result to late subscribers', async () => {
    const p = project({ files: { 'lib/tokens.ts': '' } });
    const bridge = await createPurserBridge({ projectDir: p.dir, config: purserConfig() });
    const other = await createPurserBridge({ projectDir: p.dir, config: purserConfig() });
    const first: PurserBuildResult[] = [];
    const second: PurserBuildResult[] = [];
    const h1 = await bridge.watch((r) => first.push(r), { devDiagnostics: true });
    const h2 = await other.watch((r) => second.push(r));
    const state = fakePurserState();
    expect(state.calls.filter((c) => c.method === 'watch')).toHaveLength(1);
    expect(state.watchers).toHaveLength(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    state.watchers[0]!.emit({ css: null, diagnostics: [], stats: null, written: false, outFile: null });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    h1.close();
    h1.close();
    expect(state.watchers[0]!.closed).toBe(false);
    state.watchers[0]!.emit({ css: null, diagnostics: [], stats: null, written: false, outFile: null });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(3);
    h2.close();
    expect(state.watchers[0]!.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(p.dir, '.hypdriv', 'dev', 'purser.json'))).toBe(true);

    const h3 = await bridge.watch();
    expect(state.watchers).toHaveLength(2);
    h3.close();
    expect(state.watchers[1]!.closed).toBe(true);
  });

  it('throws E_UNSUPPORTED with install instructions when Purser is missing', async () => {
    const p = project({ purser: false });
    await expect(createPurserBridge({ projectDir: p.dir, config: purserConfig() })).rejects.toMatchObject({
      code: 'E_UNSUPPORTED',
      message: expect.stringContaining('pnpm add -D @avonao/purser'),
    });
  });

  it('throws E_UNSUPPORTED on TypeScript 7 hosts and names the typescript6 alias', async () => {
    const p = project({ typescript: '7.0.2', files: { 'lib/tokens.ts': '' } });
    const err = await createPurserBridge({ projectDir: p.dir, config: purserConfig() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HypDrivError);
    expect((err as HypDrivError).code).toBe('E_UNSUPPORTED');
    expect((err as HypDrivError).message).toContain('@typescript/typescript6');
    const bridge = await createPurserBridge({
      projectDir: p.dir,
      config: purserConfig(),
      skipTypeScriptCheck: true,
    });
    expect(bridge.detection.typescriptCompatible).toBe(false);
  });

  it('rejects a module without the build API', async () => {
    const p = project({ files: { 'lib/tokens.ts': '' } });
    p.write('node_modules/@avonao/purser/src/build/index.js', 'export const nothing = 1;\n');
    await expect(createPurserBridge({ projectDir: p.dir, config: purserConfig() })).rejects.toMatchObject({
      code: 'E_UNSUPPORTED',
      message: expect.stringContaining('does not export build()'),
    });
  });
});

describe('formatPurserDiagnostic', () => {
  it('prints Purser CLI style lines', () => {
    expect(
      formatPurserDiagnostic({ severity: 'error', message: 'm', file: '/p/a.ts', line: 2, column: 7 }, '/p'),
    ).toBe('a.ts:2:7: error: m');
    expect(formatPurserDiagnostic({ severity: 'error', message: 'm', file: '/p/a.ts', line: 2 }, '/p')).toBe(
      'a.ts:2:1: error: m',
    );
    expect(formatPurserDiagnostic({ severity: 'warning', message: 'm', file: '/elsewhere/a.ts' }, '/p')).toBe(
      '/elsewhere/a.ts: warning: m',
    );
    expect(formatPurserDiagnostic({ severity: 'error', message: 'm' }, '/p')).toBe('error: m');
  });
});
