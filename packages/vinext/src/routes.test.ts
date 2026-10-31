import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appSegment,
  discoverAppRoutes,
  discoverPagesRoutes,
  discoverRoutes,
  findRouterDirs,
  fromVinextPattern,
  readSegmentConfig,
} from './routes';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-vinext-routes-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

const page = 'export default function Page() { return null; }\n';

describe('App Router discovery', () => {
  it('follows Next.js conventions', () => {
    const root = project({
      'app/layout.tsx': page,
      'app/page.tsx': page,
      'app/about/page.mdx': '# About',
      'app/(marketing)/pricing/page.tsx': page,
      'app/blog/[slug]/page.tsx': 'export const revalidate = 60;\nexport default function P() {}',
      'app/docs/[...path]/page.tsx': page,
      'app/shop/[[...filters]]/page.tsx': page,
      'app/dashboard/page.tsx': page,
      'app/dashboard/@analytics/page.tsx': page,
      'app/dashboard/@analytics/visits/page.tsx': page,
      'app/_components/page.tsx': page,
      'app/feed/(.)photo/[id]/page.tsx': page,
      'app/%5Fnext-gen/page.tsx': page,
      'app/api/hello/route.ts': 'export function GET() {}',
      'app/sitemap.ts': 'export default function sitemap() { return []; }',
      'app/robots.txt': 'User-agent: *',
      'app/blog/sitemap.xml': '<urlset/>',
      'app/manifest.json': '{}',
      'app/news/page.tsx':
        "export const revalidate = 30;\nexport const dynamic = 'force-dynamic';\nexport default 1;",
      'app/static/page.tsx': 'export const revalidate = false;\nexport default 1;',
    });
    const routes = discoverAppRoutes(join(root, 'app'), { root });
    const byId = Object.fromEntries(routes.map((r) => [`${r.kind}:${r.pathname}`, r]));
    expect(Object.keys(byId).sort()).toEqual(
      [
        'endpoint:/api/hello',
        'endpoint:/blog/sitemap.xml',
        'endpoint:/manifest.json',
        'endpoint:/robots.txt',
        'endpoint:/sitemap.xml',
        'page:/',
        'page:/_next-gen',
        'page:/about',
        'page:/blog/[slug]',
        'page:/dashboard',
        'page:/dashboard/visits',
        'page:/docs/[...path]',
        'page:/news',
        'page:/pricing',
        'page:/shop/[[...filters]]',
        'page:/static',
      ].sort(),
    );
    expect(byId['page:/blog/[slug]']).toMatchObject({
      revalidate: 60,
      sourcePage: 'app/blog/[slug]/page.tsx',
    });
    // force-dynamic wins over revalidate; `revalidate = false` is not ISR.
    expect(byId['page:/news']?.revalidate).toBeUndefined();
    expect(byId['page:/static']?.revalidate).toBeUndefined();
    expect(byId['page:/dashboard']?.sourcePage).toBe('app/dashboard/page.tsx');
  });

  it('classifies folder names', () => {
    expect(appSegment('(group)')).toBeNull();
    expect(appSegment('@slot')).toBeNull();
    expect(appSegment('_private')).toBe(false);
    expect(appSegment('(.)photo')).toBe(false);
    expect(appSegment('(..)photo')).toBe(false);
    expect(appSegment('(..)(..)photo')).toBe(false);
    expect(appSegment('(...)photo')).toBe(false);
    expect(appSegment('%5Fescaped')).toBe('_escaped');
    expect(appSegment('[id]')).toBe('[id]');
  });

  it('reads segment config', () => {
    expect(readSegmentConfig('export const revalidate = 3_600;')).toEqual({ revalidate: 3600 });
    expect(readSegmentConfig('export const revalidate: number = 5')).toEqual({ revalidate: 5 });
    expect(readSegmentConfig('export const revalidate = false')).toEqual({ revalidate: false });
    expect(readSegmentConfig('export const dynamic = "force-static"')).toEqual({ dynamic: 'force-static' });
    expect(readSegmentConfig('const revalidate = 10')).toEqual({});
  });
});

describe('Pages Router discovery and router directories', () => {
  it('discovers pages and API routes and merges both routers', () => {
    const root = project({
      'src/pages/_app.tsx': page,
      'src/pages/_document.tsx': page,
      'src/pages/404.tsx': page,
      'src/pages/index.tsx': page,
      'src/pages/posts/[id].tsx': page,
      'src/pages/posts/index.tsx': page,
      'src/pages/api/users/[id].ts': 'export default function h() {}',
      'src/app/page.tsx': page,
      'src/app/settings/page.tsx': page,
    });
    const dirs = findRouterDirs(root);
    expect(dirs).toEqual({ appDir: join(root, 'src', 'app'), pagesDir: join(root, 'src', 'pages') });
    const pages = discoverPagesRoutes(dirs.pagesDir!, { root });
    expect(pages.map((r) => `${r.kind}:${r.pathname}`).sort()).toEqual([
      'endpoint:/api/users/[id]',
      'page:/',
      'page:/posts',
      'page:/posts/[id]',
    ]);
    // `/` exists in both routers: the App Router route wins.
    const all = discoverRoutes(root, dirs);
    expect(all.filter((r) => r.pathname === '/')).toHaveLength(1);
    expect(all.find((r) => r.pathname === '/')?.sourcePage).toBe('src/app/page.tsx');
    expect(all.some((r) => r.pathname === '/settings')).toBe(true);
  });

  it('honours vinext’s appDir option', () => {
    const root = project({ 'web/app/page.tsx': page, 'app/page.tsx': page });
    expect(findRouterDirs(root, 'web')).toEqual({ appDir: join(root, 'web', 'app'), pagesDir: null });
    expect(findRouterDirs(root).appDir).toBe(join(root, 'app'));
  });
});

describe('vinext route patterns', () => {
  it('converts to the canonical syntax', () => {
    expect(fromVinextPattern('/')).toBe('/');
    expect(fromVinextPattern('/blog/:slug')).toBe('/blog/[slug]');
    expect(fromVinextPattern('/docs/:path+')).toBe('/docs/[...path]');
    expect(fromVinextPattern('/shop/:filters*')).toBe('/shop/[[...filters]]');
    expect(fromVinextPattern('/:lang?/about')).toBe('/[[lang]]/about');
  });
});
