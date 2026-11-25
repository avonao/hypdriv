import { join } from 'node:path';
import { HypDrivError } from '@hypdriv/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeProject, type FakeProject } from './__fixtures__/project';
import {
  detectPurser,
  findTokensFile,
  readStrikeScript,
  TOKENS_FILE_CANDIDATES,
  versionAtLeast,
} from './detect';

const projects: FakeProject[] = [];
const project = (...args: Parameters<typeof createFakeProject>) => {
  const p = createFakeProject(...args);
  projects.push(p);
  return p;
};
afterEach(() => {
  for (const p of projects.splice(0)) p.cleanup();
});

describe('detectPurser', () => {
  it('reports an installed Purser with a compatible TypeScript and the tokens file', () => {
    const p = project({ typescript: '5.9.3', files: { 'lib/tokens.ts': 'export const t = {}' } });
    const d = detectPurser(p.dir);
    expect(d).toMatchObject({
      installed: true,
      version: '0.1.0',
      typescriptVersion: '5.9.3',
      typescriptCompatible: true,
      tokensFile: 'lib/tokens.ts',
      message: null,
    });
    expect(d.packageDir).toBe(join(p.dir, 'node_modules', '@avonao', 'purser'));
    expect(d.strikeScriptFile).toBe(
      join(p.dir, 'node_modules', '@avonao', 'purser', 'scripts', 'strike-count.js'),
    );
  });

  it('flags TypeScript 7 as incompatible and points to the typescript6 alias', () => {
    const p = project({ typescript: '7.0.2', files: { 'app/tokens.ts': '' } });
    const d = detectPurser(p.dir);
    expect(d.typescriptVersion).toBe('7.0.2');
    expect(d.typescriptCompatible).toBe(false);
    expect(d.tokensFile).toBe('app/tokens.ts');
    expect(d.message).toContain('@typescript/typescript6');
  });

  it('reports a missing Purser or TypeScript with install hints', () => {
    const none = detectPurser(project({ purser: false, typescript: null }).dir);
    expect(none).toMatchObject({
      installed: false,
      version: null,
      typescriptVersion: null,
      typescriptCompatible: false,
    });
    expect(none.message).toContain('@avonao/purser is not installed');
    // the Purser that gets installed brings its own parser: a missing typescript is no problem of its own
    expect(none.message).not.toContain('typescript is not installed');
    const old = detectPurser(project({ typescript: null }).dir);
    expect(old.message).toContain('typescript is not installed');
    expect(old.message).toContain('0.2 and later bring their own parser');

    const noTokens = detectPurser(project({ typescript: '6.0.3' }).dir);
    expect(noTokens.typescriptCompatible).toBe(true);
    expect(noTokens.tokensFile).toBeNull();
    expect(noTokens.message).toContain('No tokens module found');
  });

  it('knows Purser 0.2: its own parser, the compiler and the naming options', () => {
    const files = { 'lib/tokens.ts': '' };
    const onSeven = detectPurser(project({ purser: { version: '0.2.0' }, typescript: '7.0.2', files }).dir);
    expect(onSeven).toMatchObject({
      version: '0.2.0',
      compiler: true,
      typescriptCompatible: true,
      message: null,
    });
    const bare = detectPurser(project({ purser: { version: '0.3.1' }, typescript: null, files }).dir);
    expect(bare).toMatchObject({
      compiler: true,
      typescriptCompatible: true,
      typescriptVersion: null,
      message: null,
    });
    expect(detectPurser(project({ files }).dir).compiler).toBe(false);
    expect(versionAtLeast('0.2.0', 0, 2)).toBe(true);
    expect(versionAtLeast('0.2.0-preview.1', 0, 2)).toBe(true);
    expect(versionAtLeast('1.0.0', 0, 2)).toBe(true);
    expect(versionAtLeast('0.1.9', 0, 2)).toBe(false);
    expect(versionAtLeast(null, 0, 2)).toBe(false);
    expect(versionAtLeast('next', 0, 2)).toBe(false);
  });

  it('follows the documented tokens candidate order', () => {
    expect(TOKENS_FILE_CANDIDATES[0]).toBe('lib/tokens.ts');
    const p = project({ files: { 'tokens.ts': '', 'src/lib/tokens.ts': '' } });
    expect(findTokensFile(p.dir)).toBe('src/lib/tokens.ts');
  });
});

describe('readStrikeScript', () => {
  it('reads scripts/strike-count.js from the installed package', () => {
    const p = project();
    expect(readStrikeScript(p.dir)).toContain('purserStrikeCount');
  });

  it('throws E_UNSUPPORTED when Purser or the script is missing', () => {
    expect(() => readStrikeScript(project({ purser: false }).dir)).toThrow(HypDrivError);
    try {
      readStrikeScript(project({ purser: { strikeScript: false } }).dir);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HypDrivError);
      expect((err as HypDrivError).code).toBe('E_UNSUPPORTED');
      expect((err as HypDrivError).message).toContain('strike-count.js');
    }
  });
});
