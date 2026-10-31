import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emptyManifest, type HypDrivConfig, type HypManifest } from '@hypdriv/core';
import { loadHypConfig, manifestModuleCode } from '@hypdriv/vite';
import { afterAll, describe, expect, it } from 'vitest';
import { clientFiles, documentPathname, eraseToken, finalizeReactRouterBuild } from './build';
import type { RouteManifestEntryLike } from './routes';
import { bundleConfig, functionRoutes, launcherSource, pathsSource, serverBundlesOf } from './vercel';

// Temporary projects live below the package's node_modules so the Vercel function trace and the Routing
// Middleware build resolve react-router and @hypdriv/vite like an application would.
const base = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.hypdriv-test');
mkdirSync(base, { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'c'.repeat(64);
const config: HypDrivConfig = {
  site: { name: 'rr-build-test' },
  performance: { earlyHints: true },
};

const routes: Record<string, RouteManifestEntryLike> = {
  root: { id: 'root', path: '', file: 'root.tsx' },
  'routes/home': { id: 'routes/home', parentId: 'root', index: true, file: 'routes/home.tsx' },
  'routes/about': { id: 'routes/about', parentId: 'root', path: 'about', file: 'routes/about.tsx' },
  'routes/ssr': { id: 'routes/ssr', parentId: 'root', path: 'ssr', file: 'routes/ssr.tsx' },
  'routes/static': {
    id: 'routes/static',
    parentId: 'root',
    path: 'api/static.json',
    file: 'routes/static.ts',
  },
};

const browser = {
  version: 'b200abaa',
  entry: { module: '/assets/entry.client-1.js', imports: ['/assets/jsx-runtime-1.js'], css: [] },
  routes: {
    root: {
      id: 'root',
      path: '',
      module: '/assets/root-1.js',
      imports: [],
      css: ['/assets/root-1.css'],
      hasDefaultExport: true,
      hasErrorBoundary: true,
    },
    'routes/home': {
      id: 'routes/home',
      parentId: 'root',
      index: true,
      module: '/assets/home-1.js',
      hasDefaultExport: true,
    },
    'routes/about': {
      id: 'routes/about',
      parentId: 'root',
      path: 'about',
      module: '/assets/about-1.js',
      hasDefaultExport: true,
    },
    'routes/ssr': {
      id: 'routes/ssr',
      parentId: 'root',
      path: 'ssr',
      module: '/assets/ssr-1.js',
      hasDefaultExport: true,
    },
    'routes/static': {
      id: 'routes/static',
      parentId: 'root',
      path: 'api/static.json',
      module: '/assets/static-1.js',
      hasDefaultExport: false,
      hasErrorBoundary: false,
    },
  },
};

const page = (title: string, script: string) =>
  `<!DOCTYPE html><html><head><title>${title}</title><link rel="stylesheet" href="/assets/root-1.css"/></head><body><h1>${title}</h1><script>${script}</script><script type="module">import "/assets/entry.client-1.js";</script></body></html>`;

/** A finished React Router build on disk: client output with prerendered pages, a server bundle with the manifest. */
function project(options: { spa?: boolean; bundles?: string[] } = {}): string {
  const root = mkdtempSync(join(base, 'project-'));
  made.push(root);
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  write('package.json', JSON.stringify({ name: 'fixture', type: 'module' }));
  for (const r of Object.values(routes)) write(`app/${r.file}`, 'export default function Route() {}');
  write(
    'build/client/assets/manifest-b200abaa.js',
    `window.__reactRouterManifest=${JSON.stringify(browser)};`,
  );
  write('build/client/assets/entry.client-1.js', 'console.log(1)');
  write('build/client/assets/jsx-runtime-1.js', 'export {}');
  write('build/client/assets/root-1.js', 'export {}');
  write('build/client/assets/root-1.css', 'body{margin:0}');
  write('build/client/robots.txt', 'User-agent: *');
  write('build/client/about/index.html', page('About', 'window.__about = 1'));
  write('build/client/about.data', '[]');
  write('build/client/api/static.json', '{"ok":true}');
  if (options.spa) {
    write('build/client/index.html', page('Home', 'window.__home = 1'));
    write('build/client/__spa-fallback.html', page('Shell', 'window.__shell = 1'));
  } else write('build/client/index.html', page('Home', 'window.__home = 1'));
  const server = (file: string) =>
    write(
      file,
      [
        manifestModuleCode(emptyManifest()).replace('export default manifest;', 'export { manifest };'),
        `export const prerenderToken = ${JSON.stringify(TOKEN)};`,
        'export const routes = {};',
        "export default function handler() { return new Response('ok'); }",
        '',
      ].join('\n'),
    );
  if (options.bundles) for (const id of options.bundles) server(`build/server/${id}/index.js`);
  else server('build/server/index.js');
  return root;
}

async function finalize(
  root: string,
  target: 'cloudflare' | 'vercel' | 'node',
  extra: Record<string, unknown> = {},
) {
  return finalizeReactRouterBuild({
    root,
    reactRouterConfig: {
      appDirectory: join(root, 'app'),
      basename: '/',
      buildDirectory: join(root, 'build'),
      routes,
      ssr: extra.ssr !== false,
      serverBuildFile: 'index.js',
    },
    viteConfig: { root, base: '/', build: { assetsDir: 'assets' } },
    config: await loadHypConfig(root, config),
    target,
    token: TOKEN,
    manifestBundled: true,
    vercelMiddleware: false,
    ...extra,
  });
}

describe('finalizeReactRouterBuild', () => {
  it('writes the manifest, patches the server build, erases the token and writes Cloudflare _headers', async () => {
    const root = project();
    const result = await finalize(root, 'cloudflare');
    const byPath = Object.fromEntries(result.manifest.routes.map((r) => [r.pathname, r]));
    expect(result.manifest.framework?.name).toBe('react-router');
    expect(result.manifest.framework?.adapter).toBe('cloudflare');
    expect(byPath['/']?.classification).toBe('static');
    expect(byPath['/about']?.classification).toBe('static');
    expect(byPath['/ssr']?.classification).toBe('dynamic');
    expect(byPath['/api/static.json']?.kind).toBe('endpoint');
    expect(result.manifest.csp['page:/about']?.scriptHashes.length).toBeGreaterThan(0);
    expect(result.manifest.earlyHints['page:/ssr']?.join()).toContain('/assets/ssr-1.js');
    expect(result.documents.map((d) => d.pathname).sort()).toEqual(['/', '/about']);

    const server = readFileSync(join(root, 'build/server/index.js'), 'utf8');
    expect(result.patched).toHaveLength(1);
    expect(server).toContain(result.manifest.fingerprint);
    expect(server).not.toContain(TOKEN);
    expect(server).toContain('prerenderToken = ""');
    expect(result.tokenErased).toHaveLength(1);

    const headers = readFileSync(join(root, 'build/client/_headers'), 'utf8');
    expect(headers).toContain('/about\n');
    expect(headers).toMatch(/\/about\n {2}content-security-policy: [^\n]*'sha256-/);
    expect(headers).toContain('/assets/*\n  cache-control: public, max-age=31536000, immutable');
    expect(readFileSync(join(root, 'build/client/.assetsignore'), 'utf8')).toContain('.hypdriv');
    const written = JSON.parse(readFileSync(join(root, '.hypdriv/manifest.json'), 'utf8')) as HypManifest;
    expect(written.fingerprint).toBe(result.manifest.fingerprint);
  });

  it('fails when the bundled runtime manifest cannot be found', async () => {
    const root = project();
    writeFileSync(join(root, 'build/server/index.js'), 'export default 1;');
    await expect(finalize(root, 'node')).rejects.toThrow(/stale manifest/);
  });

  it('writes the Vercel Build Output: header routes, document rewrites, a traced function', async () => {
    const root = project();
    const result = await finalize(root, 'vercel');
    const out = join(root, '.vercel/output');
    const configJson = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')) as {
      routes: Array<Record<string, unknown>>;
    };
    const srcs = configJson.routes.map((r) => r.src ?? r.handle);
    const fs = srcs.indexOf('filesystem');
    // Header rules precede the document rewrites; functions come after the filesystem.
    expect(srcs.indexOf('^/about$')).toBeLessThan(srcs.indexOf('^/about/?$'));
    expect(srcs.indexOf('^/about/?$')).toBeLessThan(fs);
    expect(configJson.routes.find((r) => r.src === '^/about/?$')).toMatchObject({
      dest: '/about/index.html',
      methods: ['GET', 'HEAD'],
    });
    expect(configJson.routes.find((r) => r.src === '^/about$')).toMatchObject({ methods: ['GET', 'HEAD'] });
    expect(configJson.routes.at(-1)).toEqual({ src: '^/.*$', dest: '/index' });
    expect(existsSync(join(out, 'static/about/index.html'))).toBe(true);
    expect(existsSync(join(out, 'static/_headers'))).toBe(false);

    const vc = JSON.parse(readFileSync(join(out, 'functions/index.func/.vc-config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(vc).toMatchObject({ launcherType: 'Nodejs', useWebApi: true, supportsResponseStreaming: true });
    const handler = join(out, 'functions/index.func', String(vc.handler));
    expect(readFileSync(handler, 'utf8')).toContain("typeof build.default === 'function'");
    // The function carries the patched server build, without the token.
    const bundled = readFileSync(join(dirname(handler), 'index.js'), 'utf8');
    expect(bundled).toContain(result.manifest.fingerprint);
    expect(bundled).not.toContain(TOKEN);
    // Vercel's Node.js launcher imports the handler and calls its default export with the request.
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { default: fn } = await import(${JSON.stringify(pathToFileURL(handler).href)}); console.log(await (await fn(new Request('https://x.example/'))).text());`,
      ],
      { encoding: 'utf8' },
    );
    expect(output.trim()).toBe('ok');
  });

  it('writes one function per server bundle with the bundle’s settings', async () => {
    const small = `nodejs_${Buffer.from(JSON.stringify({ runtime: 'nodejs' })).toString('base64url')}`;
    const big = `nodejs_${Buffer.from(JSON.stringify({ maxDuration: 15, memory: 1024, runtime: 'nodejs' })).toString('base64url')}`;
    const root = project({ bundles: [small, big] });
    await finalize(root, 'vercel', {
      buildManifest: {
        routes,
        serverBundles: {
          [small]: { id: small, file: `build/server/${small}/index.js` },
          [big]: { id: big, file: `build/server/${big}/index.js` },
        },
        routeIdToServerBundleId: {
          'routes/home': small,
          'routes/about': small,
          'routes/ssr': big,
          'routes/static': small,
        },
      },
    });
    const out = join(root, '.vercel/output');
    const vc = JSON.parse(readFileSync(join(out, `functions/${big}.func/.vc-config.json`), 'utf8')) as {
      maxDuration: number;
      memory: number;
    };
    expect(vc.maxDuration).toBe(15);
    expect(vc.memory).toBe(1024);
    const configJson = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')) as {
      routes: Array<{ src?: string; dest?: string }>;
    };
    expect(configJson.routes.find((r) => r.src === '^/ssr(?:/)?$')?.dest).toBe(`/${big}`);
    expect(configJson.routes.find((r) => r.src === '^/ssr(?:/_)?\\.data$')?.dest).toBe(`/${big}`);
    expect(configJson.routes.at(-1)).toEqual({ src: '^/.*$', dest: `/${small}` });
  });

  it('builds HypDriv’s Routing Middleware for the statically served paths', async () => {
    const root = project();
    await finalize(root, 'vercel', { vercelMiddleware: true });
    const out = join(root, '.vercel/output');
    const configJson = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')) as {
      routes: Array<{ src?: string; middlewarePath?: string; middlewareRawSrc?: string[] }>;
    };
    const middleware = configJson.routes.find((r) => r.middlewarePath === '_hypdriv/middleware');
    expect(middleware?.middlewareRawSrc).toEqual(
      expect.arrayContaining(['/', '/about', '/about.data', '/api/static.json']),
    );
    expect(new RegExp(middleware!.src!).test('/ssr')).toBe(false);
    expect(new RegExp(middleware!.src!).test('/about')).toBe(true);
    expect(existsSync(join(out, 'functions/_hypdriv/middleware.func/index.mjs'))).toBe(true);
  }, 120_000);

  it('gives single-page apps a catch-all route with the shell’s policy', async () => {
    const root = project({ spa: true });
    const result = await finalize(root, 'vercel', { ssr: false });
    const catchAll = result.manifest.routes.find((r) => r.pathname === '/[...path]');
    expect(catchAll?.fallback).toBe(true);
    expect(result.manifest.csp[catchAll!.id]?.scriptHashes.length).toBeGreaterThan(0);
    // Routes without their own document are served the shell: they get its policy.
    const ssr = result.manifest.routes.find((r) => r.pathname === '/ssr');
    expect(result.manifest.csp[ssr!.id]).toEqual(result.manifest.csp[catchAll!.id]);
    const out = join(root, '.vercel/output');
    const configJson = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')) as {
      routes: Array<{ src?: string; dest?: string; headers?: Record<string, string> }>;
    };
    expect(configJson.routes.at(-1)).toMatchObject({ dest: '/__spa-fallback.html', check: true });
    expect(
      configJson.routes.find((r) => r.src === '^/(?:.*)$')?.headers?.['content-security-policy'],
    ).toBeTruthy();
    expect(existsSync(join(out, 'functions/index.func'))).toBe(false);
  });
});

describe('build helpers', () => {
  it('maps prerendered files to URL paths', () => {
    expect(documentPathname('index.html')).toBe('/');
    expect(documentPathname('/about/index.html')).toBe('/about');
    expect(documentPathname('blog/post/index.html')).toBe('/blog/post');
    expect(documentPathname('404.html')).toBe('/404');
  });

  it('lists client files outside the assets directory and dot-directories', () => {
    const root = project();
    mkdirSync(join(root, 'build/client/.vite'), { recursive: true });
    writeFileSync(join(root, 'build/client/.vite/manifest.json'), '{}');
    expect(clientFiles(join(root, 'build/client'), 'assets')).toEqual([
      '/about.data',
      '/about/index.html',
      '/api/static.json',
      '/index.html',
      '/robots.txt',
    ]);
  });

  it('erases the token from code and source maps only', () => {
    const root = project();
    writeFileSync(join(root, 'build/server/index.js.map'), `{"sourcesContent":["${TOKEN}"]}`);
    writeFileSync(join(root, 'build/server/notes.txt'), TOKEN);
    const touched = eraseToken([join(root, 'build/server')], TOKEN);
    expect(touched.map((f) => f.slice(root.length))).toEqual([
      '/build/server/index.js',
      '/build/server/index.js.map',
    ]);
    expect(readFileSync(join(root, 'build/server/notes.txt'), 'utf8')).toBe(TOKEN);
    expect(eraseToken([join(root, 'build/server')], '')).toEqual([]);
  });

  it('decodes @vercel/react-router bundle settings and builds function routes', () => {
    const id = `nodejs_${Buffer.from(JSON.stringify({ maxDuration: 30, regions: ['iad1'] })).toString('base64url')}`;
    expect(bundleConfig({ id })).toEqual({ maxDuration: 30, regions: ['iad1'] });
    expect(bundleConfig({ id, config: { memory: 512 } })).toEqual({ memory: 512 });
    expect(bundleConfig({ id: 'custom' })).toEqual({});
    expect(
      serverBundlesOf({ root: '/p', serverDir: '/p/build/server', serverBuildFile: 'index.js' }),
    ).toEqual([{ id: 'index', file: 'build/server/index.js' }]);
    const [data, page] = functionRoutes('/blog/[slug]', '/fn');
    expect(new RegExp(data!.src!).test('/blog/hello.data')).toBe(true);
    expect(new RegExp(page!.src!).test('/blog/hello')).toBe(true);
    expect(new RegExp(functionRoutes('/', '/fn')[0]!.src!).test('/_root.data')).toBe(true);
    expect(new RegExp(pathsSource(['/a.b', '/'])).test('/a.b')).toBe(true);
    expect(new RegExp(pathsSource(['/a.b'])).test('/axb')).toBe(false);
    expect(launcherSource('index.js')).toContain('import * as build from "./index.js"');
  });
});
