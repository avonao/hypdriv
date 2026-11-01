import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StartDocument } from './documents';
import { writeVercelOverrides } from './vercel';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function output(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hypdriv-solid-vercel-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

const doc = (relative: string, pathname: string): StartDocument => ({
  relative,
  pathname,
  file: `/x/${relative}`,
});

describe('writeVercelOverrides', () => {
  it('maps prerendered documents to their clean URLs, leaving the index to the CDN', () => {
    const dir = output({ version: 3, routes: [{ src: '/x' }] });
    const mapped = writeVercelOverrides(dir, [
      doc('index.html', '/'),
      doc('about/index.html', '/about'),
      doc('docs.html', '/docs'),
      doc('blog/a/index.html', '/blog/a'),
    ]);
    expect(mapped).toBe(3);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(config.routes).toEqual([{ src: '/x' }]);
    expect(config.overrides).toEqual({
      'about/index.html': { path: 'about', contentType: 'text/html; charset=utf-8' },
      'docs.html': { path: 'docs', contentType: 'text/html; charset=utf-8' },
      'blog/a/index.html': { path: 'blog/a', contentType: 'text/html; charset=utf-8' },
    });
  });

  it('keeps existing overrides and their fields', () => {
    const dir = output({
      version: 3,
      overrides: { 'about/index.html': { path: 'old', extra: 1 }, 'x.png': { path: 'y' } },
    });
    writeVercelOverrides(dir, [doc('about/index.html', '/about')]);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(config.overrides['x.png']).toEqual({ path: 'y' });
    expect(config.overrides['about/index.html']).toEqual({
      path: 'about',
      extra: 1,
      contentType: 'text/html; charset=utf-8',
    });
  });

  it('does nothing without a Build Output', () => {
    expect(writeVercelOverrides(join(tmpdir(), 'hypdriv-solid-no-output'), [doc('a.html', '/a')])).toBe(0);
  });
});
