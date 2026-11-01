import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeVercelOverrides } from './vercel';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function output(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hypdriv-waku-vercel-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

const read = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;

describe('writeVercelOverrides', () => {
  it('serves each prerendered document at its clean URL and keeps the rest of the config', () => {
    const dir = output({ version: 3, routes: [{ handle: 'filesystem' }] });
    const mapped = writeVercelOverrides(dir, [
      { relative: 'index.html', basePath: '' },
      { relative: 'about/index.html', basePath: '' },
      { relative: 'blog/a/index.html', basePath: '' },
    ]);
    expect(mapped).toBe(2);
    const config = read(dir);
    expect(config.routes).toEqual([{ handle: 'filesystem' }]);
    expect(config.overrides).toEqual({
      'about/index.html': { path: 'about', contentType: 'text/html; charset=utf-8' },
      'blog/a/index.html': { path: 'blog/a', contentType: 'text/html; charset=utf-8' },
    });
  });

  it('puts the documents under the base path', () => {
    const dir = output({ version: 3 });
    expect(
      writeVercelOverrides(dir, [
        { relative: 'index.html', basePath: '/docs' },
        { relative: 'about/index.html', basePath: '/docs' },
      ]),
    ).toBe(2);
    expect(read(dir).overrides).toEqual({
      'index.html': { path: 'docs', contentType: 'text/html; charset=utf-8' },
      'about/index.html': { path: 'docs/about', contentType: 'text/html; charset=utf-8' },
    });
  });

  it('keeps overrides that are already there and does nothing without a Build Output', () => {
    const dir = output({ version: 3, overrides: { 'robots.txt': { contentType: 'text/plain' } } });
    writeVercelOverrides(dir, [{ relative: 'about/index.html', basePath: '' }]);
    expect(Object.keys(read(dir).overrides as object).sort()).toEqual(['about/index.html', 'robots.txt']);
    const empty = mkdtempSync(join(tmpdir(), 'hypdriv-waku-vercel-'));
    dirs.push(empty);
    expect(writeVercelOverrides(empty, [{ relative: 'about/index.html', basePath: '' }])).toBe(0);
  });
});
