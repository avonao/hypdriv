import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  explicitTags,
  fileDigest,
  prerenderedPages,
  prerenderOutputPath,
  readPrerenderManifest,
  staticCacheDigests,
} from './prerender';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-vinext-prerender-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

describe('prerender output paths', () => {
  it('maps pathnames like vinext', () => {
    expect(prerenderOutputPath('/', false)).toBe('index.html');
    expect(prerenderOutputPath('/about', false)).toBe('about.html');
    expect(prerenderOutputPath('/about', true)).toBe('about/index.html');
    expect(prerenderOutputPath('/index', false)).toBe('index/index.html');
    expect(prerenderOutputPath('/blog/a', false, '/docs')).toBe('docs/blog/a.html');
    expect(prerenderOutputPath('/', false, '/docs')).toBe('docs.html');
  });

  it('separates explicit cache tags from implicit path tags', () => {
    expect(explicitTags(['/about', '_N_T_/about', '_N_T_/layout', 'products'])).toEqual(['products']);
    expect(explicitTags(undefined)).toEqual([]);
  });
});

describe('prerendered pages', () => {
  it('lists rendered page documents with their pattern, revalidation and tags', () => {
    const root = tree({
      'server/vinext-prerender.json': JSON.stringify({
        buildId: 'b',
        trailingSlash: false,
        routes: [
          { route: '/api/hello', status: 'skipped', reason: 'api' },
          { route: '/', status: 'rendered', revalidate: false, router: 'app', tags: ['/', '_N_T_/'] },
          { route: '/news', status: 'rendered', revalidate: 60, router: 'app', tags: ['_N_T_/news', 'news'] },
          { route: '/blog/:slug', path: '/blog/a', status: 'rendered', revalidate: false, router: 'app' },
          { route: '/404', status: 'rendered', revalidate: false, router: 'app' },
          { route: '/gone', status: 'rendered', router: 'pages', notFound: true },
          { route: '/moved', status: 'rendered', router: 'app', responseStatus: 307 },
          { route: '/robots.txt', status: 'rendered', router: 'metadata' },
          { route: '/missing', status: 'rendered', router: 'app' },
        ],
      }),
      'server/prerendered-routes/index.html': '<html>home</html>',
      'server/prerendered-routes/news.html': '<html>news</html>',
      'server/prerendered-routes/blog/a.html': '<html>a</html>',
      'server/prerendered-routes/404.html': '<html>404</html>',
      'server/prerendered-routes/gone.html': '<html>gone</html>',
      'server/prerendered-routes/moved.html': '<html>moved</html>',
    });
    const serverDir = join(root, 'server');
    const manifest = readPrerenderManifest(serverDir);
    const pages = prerenderedPages(serverDir, manifest);
    expect(pages.map((p) => [p.pathname, p.pattern, p.revalidate, p.tags])).toEqual([
      ['/', '/', false, []],
      ['/news', '/news', 60, ['news']],
      ['/blog/a', '/blog/[slug]', false, []],
    ]);
    expect(pages[0]!.file).toBe(join(serverDir, 'prerendered-routes', 'index.html'));
    expect(readPrerenderManifest(join(root, 'nope'))).toBeNull();
  });

  it('finds the documents vinext’s static assets adapter packaged, by content', () => {
    const html = '<html>about</html>';
    const root = tree({
      'client/_vinext/static-cache/index.json': JSON.stringify({
        aa11: { kind: 'html', lastModified: 1 },
        bb22: { kind: 'rsc', lastModified: 1 },
      }),
      'client/_vinext/static-cache/aa11.html': html,
      'client/_vinext/static-cache/bb22.rsc': '0:[]',
      'doc.html': html,
      'other.html': '<html>other</html>',
    });
    const digests = staticCacheDigests(join(root, 'client'));
    expect(digests?.size).toBe(1);
    expect(digests?.has(createHash('sha256').update(html).digest('hex'))).toBe(true);
    expect(digests?.has(fileDigest(join(root, 'doc.html'))!)).toBe(true);
    expect(digests?.has(fileDigest(join(root, 'other.html'))!)).toBe(false);
    expect(staticCacheDigests(join(root, 'none'))).toBeNull();
  });
});
