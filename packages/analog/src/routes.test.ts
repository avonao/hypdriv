import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analogPageAssets, analogRoutePath, discoverAnalogPages } from './routes';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-analog-'));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

describe('analogRoutePath', () => {
  it.each([
    ['index.page.ts', '/'],
    ['about.page.ts', '/about'],
    ['users/[id].page.ts', '/users/[id]'],
    ['blog.[slug].page.ts', '/blog/[slug]'],
    ['blog/index.page.ts', '/blog'],
    ['(auth)/login.page.ts', '/login'],
    ['(marketing).page.ts', '/'],
    ['docs/[...slug].page.ts', '/docs/[...slug]'],
    ['shop/[[...category]].page.ts', '/shop/[[...category]]'],
    ['[...not-found].page.ts', '/[...not-found]'],
    ['products.[category].[id].page.ts', '/products/[category]/[id]'],
    ['posts/hello.md', '/posts/hello'],
    ['posts\\windows.md', '/posts/windows'],
  ])('%s → %s', (file, route) => {
    expect(analogRoutePath(file)).toBe(route);
  });
});

describe('discoverAnalogPages', () => {
  it('lists the file router’s pages with their source files', () => {
    const root = project({
      'src/app/pages/index.page.ts': '',
      'src/app/pages/about.page.ts': '',
      'src/app/pages/(auth)/login.page.ts': '',
      'src/app/pages/blog/[slug].page.ts': '',
      'src/app/pages/docs/[...path].page.ts': '',
      'src/app/pages/index.server.ts': '// page endpoint, not a page',
      'src/app/pages/helper.ts': '// not a page',
      'src/app/app.ts': '',
    });
    const routes = discoverAnalogPages({ root });
    expect(routes.map((r) => r.pathname)).toEqual([
      '/login',
      '/about',
      '/blog/[slug]',
      '/docs/[...path]',
      '/',
    ]);
    expect(routes.every((r) => r.kind === 'page')).toBe(true);
    expect(routes.find((r) => r.pathname === '/blog/[slug]')?.sourcePage).toBe(
      'src/app/pages/blog/[slug].page.ts',
    );
  });

  it('resolves a layout and its index page to one route', () => {
    const root = project({
      'src/app/pages/users.page.ts': '',
      'src/app/pages/users/index.page.ts': '',
      'src/app/pages/users/[id].page.ts': '',
    });
    expect(discoverAnalogPages({ root }).map((r) => r.pathname)).toEqual(['/users/[id]', '/users']);
  });

  it('honours sourceRoot and additional pages directories (app pages win collisions)', () => {
    const root = project({
      'app-src/app/pages/index.page.ts': '',
      'libs/shared/pages/index.page.ts': '',
      'libs/shared/pages/pricing.page.ts': '',
      'node_modules/pkg/src/app/pages/ignored.page.ts': '',
    });
    const routes = discoverAnalogPages({
      root,
      sourceRoot: 'app-src',
      additionalPagesDirs: ['/libs/shared/pages'],
    });
    expect(routes.map((r) => [r.pathname, r.sourcePage])).toEqual([
      ['/', 'app-src/app/pages/index.page.ts'],
      ['/pricing', 'libs/shared/pages/pricing.page.ts'],
    ]);
  });

  it('adds Markdown content routes when the project uses @analogjs/content', () => {
    const files = {
      'src/app/pages/index.page.ts': '',
      'src/content/blog/hello.md': '# hi',
      'src/app/pages/docs/intro.md': '# intro',
    };
    const without = project({ ...files, 'package.json': JSON.stringify({ dependencies: {} }) });
    expect(discoverAnalogPages({ root: without }).map((r) => r.pathname)).toEqual(['/']);
    const withContent = project({
      ...files,
      'package.json': JSON.stringify({ dependencies: { '@analogjs/content': '2.9.4' } }),
    });
    expect(discoverAnalogPages({ root: withContent }).map((r) => r.pathname)).toEqual([
      '/',
      '/docs/intro',
      '/blog/hello',
    ]);
    expect(discoverAnalogPages({ root: withContent, contentRoutes: false }).map((r) => r.pathname)).toEqual([
      '/',
    ]);
    expect(discoverAnalogPages({ root: without, contentRoutes: true }).map((r) => r.pathname)).toEqual([
      '/',
      '/docs/intro',
      '/blog/hello',
    ]);
  });

  it('is empty for a project without pages', () => {
    expect(discoverAnalogPages({ root: project({ 'package.json': '{}' }) })).toEqual([]);
  });
});

describe('analogPageAssets', () => {
  const manifest = {
    'index.html': { file: 'assets/main-1.js', isEntry: true, css: ['assets/main-1.css'] },
    'src/app/pages/about.page.ts': {
      file: 'assets/about.page-2.js',
      src: 'src/app/pages/about.page.ts',
      isDynamicEntry: true,
      imports: ['_shared-3.js'],
      css: ['assets/about-2.css'],
    },
    '_shared-3.js': { file: 'assets/shared-3.js' },
  };

  it('preloads the route chunk, what it imports statically and its CSS', () => {
    const assets = analogPageAssets(
      { pathname: '/about', kind: 'page', sourcePage: 'src/app/pages/about.page.ts' },
      manifest,
      '/',
    );
    expect(assets?.js).toEqual(['/assets/about.page-2.js', '/assets/shared-3.js']);
    expect(assets?.css).toEqual(['/assets/about-2.css']);
    expect(assets?.main).toEqual(['/assets/about.page-2.js']);
  });

  it('prefixes the base the client build is served from', () => {
    const assets = analogPageAssets(
      { pathname: '/about', kind: 'page', sourcePage: 'src/app/pages/about.page.ts' },
      manifest,
      '/docs/',
    );
    expect(assets?.js[0]).toBe('/docs/assets/about.page-2.js');
  });

  it('has nothing for routes without a chunk in the manifest', () => {
    expect(analogPageAssets({ pathname: '/x', kind: 'page' }, manifest, '/')).toBeUndefined();
    expect(
      analogPageAssets(
        { pathname: '/x', kind: 'page', sourcePage: 'src/app/pages/x.page.ts' },
        manifest,
        '/',
      ),
    ).toBeUndefined();
  });
});
