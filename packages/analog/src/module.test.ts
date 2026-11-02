import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NitroLike, NitroModuleLike } from '@hypdriv/nitro';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hypdrivAnalog, withHypDriv } from './module';
import { resetViteState, viteState } from './state';

const dirs: string[] = [];
beforeEach(() => resetViteState());
afterEach(() => {
  resetViteState();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

type Hooks = Record<string, Array<(...args: unknown[]) => unknown>>;

/** A Nitro 2 instance as Analog configures it: output under `dist/analog`, handlers for the API and page endpoints. */
function fakeNitro(preset = 'node-server') {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-analog-module-'));
  dirs.push(root);
  const hooks: Hooks = {};
  const messages: string[] = [];
  const nitro: NitroLike = {
    meta: { majorVersion: 2, version: '2.13.5' },
    options: {
      preset,
      dev: false,
      rootDir: root,
      buildDir: join(root, 'dist', '.nitro'),
      baseURL: '/',
      output: {
        dir: join(root, 'dist', 'analog'),
        serverDir: join(root, 'dist', 'analog', 'server'),
        publicDir: join(root, 'dist', 'analog', 'public'),
      },
      virtual: {},
      plugins: [],
      handlers: [
        { route: '/api/hello', method: 'get', handler: join(root, 'src/server/routes/api/hello.ts') },
        { route: '/sitemap.xml', method: 'get', handler: join(root, 'src/server/routes/sitemap.xml.ts') },
        { route: '/api/_analog/pages/index', handler: join(root, 'src/app/pages/index.server.ts') },
        { route: '/api/**', handler: '#ANALOG_API_MIDDLEWARE', middleware: true },
      ],
      renderer: '#ANALOG_SSR_RENDERER',
      externals: {},
      rollupConfig: {},
      imports: { exclude: [] },
    },
    hooks: {
      hook(name, listener) {
        hooks[name] = [...(hooks[name] ?? []), listener as (...args: unknown[]) => unknown];
      },
    },
    logger: {
      debug: (m) => messages.push(m),
      info: (m) => messages.push(m),
      warn: (m) => messages.push(`warn: ${m}`),
      error: (m) => messages.push(`error: ${m}`),
    },
    scannedHandlers: [],
  };
  const fire = async (name: string, ...args: unknown[]) => {
    for (const listener of hooks[name] ?? []) await listener(...args);
  };
  return { nitro, root, hooks, messages, fire };
}

const html = (title: string) =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body><app-root>${title}</app-root><script>window.x=1</script></body></html>`;

describe('hypdrivAnalog', () => {
  it('registers the Hypdriv Nitro module for Analog', async () => {
    const { nitro } = fakeNitro();
    const module = hypdrivAnalog();
    expect(module.name).toBe('@hypdriv/analog');
    await module.setup(nitro);
    expect(Object.keys(nitro.options.virtual)).toEqual(
      expect.arrayContaining(['virtual:hypdriv/config', 'virtual:hypdriv/manifest']),
    );
    expect(nitro.options.plugins.at(-1)).toMatch(/nitro2[\\/]plugin/);
  });

  it('builds the manifest from the file router, with Nitro handlers as endpoints', async () => {
    const built = fakeNitro();
    const { nitro, root } = built;
    write(join(root, 'src/app/pages/index.page.ts'), '');
    write(join(root, 'src/app/pages/about.page.ts'), '');
    write(join(root, 'src/app/pages/blog/[slug].page.ts'), '');
    const { publicDir } = nitro.options.output;
    write(join(publicDir, 'index.html'), html('Home'));
    write(join(publicDir, 'about', 'index.html'), html('About'));
    write(
      join(publicDir, '.vite', 'manifest.json'),
      JSON.stringify({
        'index.html': { file: 'assets/main-1.js', src: 'index.html', isEntry: true },
        'src/app/pages/about.page.ts': {
          file: 'assets/about-2.js',
          src: 'src/app/pages/about.page.ts',
          isDynamicEntry: true,
        },
      }),
    );
    await hypdrivAnalog().setup(nitro);
    await built.fire('prerender:done', {
      prerenderedRoutes: [
        { route: '/', fileName: '/index.html', contentType: 'text/html' },
        { route: '/about', fileName: '/about/index.html', contentType: 'text/html' },
      ],
    });
    await built.fire('rollup:before');

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as {
      framework: { name: string; bundler?: string };
      routes: Array<{
        id: string;
        classification: string;
        assets: { js: string[] };
        sourcePage?: string;
      }>;
      staticFiles: { immutablePrefixes: string[] };
    };
    expect(manifest.framework).toMatchObject({ name: 'analog', bundler: 'vite' });
    const byId = Object.fromEntries(manifest.routes.map((r) => [r.id, r]));
    expect(byId['page:/']?.classification).toBe('static');
    expect(byId['page:/about']?.classification).toBe('static');
    expect(byId['page:/blog/[slug]']?.classification).toBe('dynamic');
    // Every Nitro handler is an endpoint, whatever its path; the middleware is not a route.
    expect(byId['endpoint:/api/hello']?.classification).toBe('route');
    expect(byId['endpoint:/sitemap.xml']?.classification).toBe('route');
    expect(byId['endpoint:/api/_analog/pages/index']).toBeDefined();
    expect(manifest.routes.some((r) => r.id.includes('**'))).toBe(false);
    // Shared entry assets plus the route's own chunk.
    expect(byId['page:/about']?.assets.js).toEqual(['/assets/main-1.js', '/assets/about-2.js']);
    expect(byId['page:/blog/[slug]']?.assets.js).toEqual(['/assets/main-1.js']);
    expect(manifest.staticFiles.immutablePrefixes).toEqual(['/assets/']);
  });

  it('reads the manifest from the client output directory when Nitro did not copy it', async () => {
    const built = fakeNitro();
    const { nitro, root } = built;
    write(join(root, 'src/app/pages/index.page.ts'), '');
    write(join(nitro.options.output.publicDir, 'index.html'), html('Home'));
    const clientOutDir = join(root, 'out', 'client');
    write(
      join(clientOutDir, '.vite', 'manifest.json'),
      JSON.stringify({ 'index.html': { file: 'assets/entry-9.js', src: 'index.html', isEntry: true } }),
    );
    viteState().clientOutDir = clientOutDir;
    await hypdrivAnalog().setup(nitro);
    await built.fire('prerender:done', { prerenderedRoutes: [] });
    await built.fire('rollup:before');
    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as {
      routes: Array<{ id: string; assets: { js: string[] } }>;
    };
    expect(manifest.routes.find((r) => r.id === 'page:/')?.assets.js).toEqual(['/assets/entry-9.js']);
  });

  it('serves the build assets from the Vite config’s assetsDir and base', async () => {
    const { nitro, root } = fakeNitro();
    write(join(root, 'src/app/pages/index.page.ts'), '');
    Object.assign(viteState(), { base: '/app/', assetsDir: 'static' });
    await hypdrivAnalog().setup(nitro);
    const options = await (nitro.options.virtual['#hypdriv/options'] as () => string)();
    expect(options).toContain('"/app/static/"');
  });

  it('lets the application override the asset prefixes', async () => {
    const { nitro } = fakeNitro();
    await hypdrivAnalog({ assetPrefixes: ['/_ng/'] }).setup(nitro);
    const options = await (nitro.options.virtual['#hypdriv/options'] as () => string)();
    expect(options).toContain('"/_ng/"');
  });
});

describe('withHypDriv', () => {
  it('prepends the module to Analog’s nitro.modules and keeps the rest of the options', () => {
    const own = { setup() {} };
    const options = withHypDriv({
      ssr: true,
      prerender: { routes: ['/'] },
      nitro: { preset: 'cloudflare-module', modules: [own] },
    });
    expect(options.ssr).toBe(true);
    expect(options.prerender).toEqual({ routes: ['/'] });
    expect(options.nitro.preset).toBe('cloudflare-module');
    const [first, second] = options.nitro.modules;
    expect(options.nitro.modules).toHaveLength(2);
    expect((first as NitroModuleLike).name).toBe('@hypdriv/analog');
    expect(second).toBe(own);
  });

  it('works without Analog options', () => {
    const options = withHypDriv();
    expect(options.nitro.modules).toHaveLength(1);
  });

  it('hands Analog’s layout options to the integration', async () => {
    const built = fakeNitro();
    const { nitro, root } = built;
    write(join(root, 'app-src/app/pages/index.page.ts'), '');
    write(join(root, 'libs/shared/pages/pricing.page.ts'), '');
    const options = withHypDriv({ sourceRoot: 'app-src', additionalPagesDirs: ['/libs/shared/pages'] });
    const [module] = options.nitro.modules as NitroModuleLike[];
    await module?.setup(nitro);
    await built.fire('prerender:done', { prerenderedRoutes: [] });
    await built.fire('rollup:before');
    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as {
      routes: Array<{ id: string }>;
    };
    expect(manifest.routes.map((r) => r.id)).toEqual(expect.arrayContaining(['page:/', 'page:/pricing']));
  });
});
