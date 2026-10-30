import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectPrerenderedHtml, pathnameFromPrerenderFile } from './prerendered';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function nextDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-next-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, '.next', rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe('collectPrerenderedHtml', () => {
  it('keys documents by pathname from app and pages output', async () => {
    const root = nextDir({
      'server/app/index.html': '<html>home</html>',
      'server/app/index.rsc': '0:["$","div",null,{"className":"xaaaaaaa"}]',
      'server/app/blog/[slug].html': '<html>post</html>',
      'server/app/blog/[slug].prefetch.rsc': '1:["$","p",null,{"className":"xbbbbbbb"}]',
      'server/app/(marketing)/pricing.html': '<html>pricing</html>',
      'server/app/_not-found.html': '<html>404</html>',
      'server/app/docs/index.html': '<html>docs</html>',
      'server/app/api/route.js': 'export {}',
      'server/pages/404.html': '<html>pages 404</html>',
      'server/pages/legacy/[id].html': '<html>legacy</html>',
      'server/chunks/x.html': '<html>never read</html>',
    });
    const plain = await collectPrerenderedHtml(join(root, '.next'));
    expect(Object.keys(plain)).toEqual(['/', '/_not-found', '/blog/[slug]', '/docs', '/pricing', '/404', '/legacy/[id]']);
    expect(plain['/']).toBe('<html>home</html>');
    expect(plain['/pricing']).toBe('<html>pricing</html>');

    const withRsc = await collectPrerenderedHtml(root, { includeRsc: true });
    expect(withRsc['/']).toBe('<html>home</html>\n0:["$","div",null,{"className":"xaaaaaaa"}]');
    expect(withRsc['/blog/[slug]']).toContain('xbbbbbbb');
  });

  it('honours file count and size limits', async () => {
    const warnings: string[] = [];
    const log = {
      level: 'debug' as const,
      debug() {},
      info() {},
      warn(m: string) {
        warnings.push(m);
      },
      error() {},
      child() {
        return log;
      },
    };
    const root = nextDir({
      'server/app/a.html': 'a',
      'server/app/b.html': 'b'.repeat(64),
      'server/app/c.html': 'c',
    });
    const limited = await collectPrerenderedHtml(join(root, '.next'), { maxFiles: 2, maxBytes: 16, log });
    expect(Object.keys(limited)).toEqual(['/a', '/c']);
    expect(warnings.some((w) => w.includes('size limit'))).toBe(true);
    const capped = await collectPrerenderedHtml(join(root, '.next'), { maxFiles: 1, log });
    expect(Object.keys(capped)).toEqual(['/a']);
    expect(warnings.some((w) => w.includes('file limit'))).toBe(true);
  });

  it('returns an empty map for a missing build and derives pathnames', async () => {
    expect(await collectPrerenderedHtml(join(tmpdir(), 'does-not-exist-hypdriv'))).toEqual({});
    expect(pathnameFromPrerenderFile('/b/app', '/b/app/index.html', '.html')).toBe('/');
    expect(pathnameFromPrerenderFile('/b/app', '/b/app/shop/[[...slug]].html', '.html')).toBe('/shop/[[...slug]]');
    expect(pathnameFromPrerenderFile('/b/app', '/b/app/(group)/@slot/x/index.html', '.html')).toBe('/x');
    expect(pathnameFromPrerenderFile('/b/app', '/b/app/a.prefetch.rsc', '.prefetch.rsc')).toBe('/a');
  });
});
