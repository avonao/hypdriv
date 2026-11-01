import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MANIFEST_SENTINEL_VALUE, VIRTUAL_CONFIG, VIRTUAL_MANIFEST } from '@hypdriv/vite';
import { afterEach, describe, expect, it } from 'vitest';
import { hypdrivNitro, type NitroLike, nitroMajor, withHypDriv } from './module';
import { VIRTUAL_CLOUDFLARE_EXPORTS, VIRTUAL_OPTIONS } from './runtime/options';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

type Hooks = Record<string, Array<(...args: unknown[]) => unknown>>;

interface FakeOptions {
  major: 2 | 3;
  preset?: string;
  dev?: boolean;
  handlers?: NitroLike['options']['handlers'];
  renderer?: NitroLike['options']['renderer'];
}

/** A Nitro instance with the parts the module touches. */
function fakeNitro({ major, preset = 'node-server', dev = false, handlers = [], renderer }: FakeOptions) {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-nitro-module-'));
  dirs.push(root);
  const hooks: Hooks = {};
  const messages: string[] = [];
  const outputDir = join(root, preset.startsWith('vercel') ? '.vercel/output' : '.output');
  const nitro: NitroLike = {
    meta: { majorVersion: major, version: major === 3 ? '3.0.0-rc' : '2.13.5' },
    options: {
      preset,
      dev,
      rootDir: root,
      buildDir: join(root, 'node_modules', '.nitro'),
      baseURL: '/',
      output: {
        dir: outputDir,
        serverDir: preset.startsWith('vercel')
          ? join(outputDir, 'functions', '__server.func')
          : join(outputDir, 'server'),
        publicDir: preset.startsWith('vercel') ? join(outputDir, 'static') : join(outputDir, 'public'),
      },
      virtual: {},
      plugins: ['/app/plugins/own.ts'],
      handlers,
      ...(renderer ? { renderer } : {}),
      ...(major === 2
        ? { externals: { inline: ['own-package'] }, rollupConfig: {}, imports: { exclude: [/node_modules/] } }
        : { noExternals: false, builtinModules: ['node:fs'], builder: 'vite' }),
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
    ...(major === 3 ? { routing: { routes: { routes: handlers } } } : { scannedHandlers: [] }),
  };
  const fire = async (name: string, ...args: unknown[]) => {
    for (const listener of hooks[name] ?? []) await listener(...args);
  };
  return { nitro, root, hooks, messages, fire };
}

async function setup(fake: ReturnType<typeof fakeNitro>, options: Parameters<typeof hypdrivNitro>[0] = {}) {
  await hypdrivNitro(options).setup(fake.nitro);
  return fake;
}

const virtual = async (nitro: NitroLike, id: string): Promise<string> => {
  const entry = nitro.options.virtual[id];
  if (entry === undefined) throw new Error(`virtual module ${id} is not registered`);
  return typeof entry === 'string' ? entry : entry();
};

describe('nitroMajor', () => {
  it('reads the version from the instance, with Nitro 3’s router as the fallback', () => {
    expect(nitroMajor(fakeNitro({ major: 2 }).nitro)).toBe(2);
    expect(nitroMajor(fakeNitro({ major: 3 }).nitro)).toBe(3);
    const bare = fakeNitro({ major: 3 }).nitro;
    delete bare.meta;
    expect(nitroMajor(bare)).toBe(3);
    delete bare.routing;
    expect(nitroMajor(bare)).toBe(2);
  });
});

describe('withHypDriv', () => {
  it('puts the module first in a Nitro config', () => {
    const own = { setup() {} };
    const config = withHypDriv({ preset: 'node-server', modules: [own] });
    expect(config.modules).toHaveLength(2);
    expect((config.modules[0] as unknown as { name: string }).name).toBe('@hypdriv/nitro');
    expect(config.modules[1]).toBe(own);
    expect(withHypDriv().modules).toHaveLength(1);
  });
});

describe('Nitro 2', () => {
  it('registers the virtual modules, the plugin and the bundling rules', async () => {
    const { nitro } = await setup(fakeNitro({ major: 2 }));
    for (const id of [VIRTUAL_CONFIG, VIRTUAL_MANIFEST, VIRTUAL_OPTIONS, VIRTUAL_CLOUDFLARE_EXPORTS])
      expect(nitro.options.virtual[id]).toBeDefined();
    expect(nitro.options.plugins[0]).toBe('/app/plugins/own.ts');
    expect(nitro.options.plugins.at(-1)).toMatch(/nitro2[\\/]plugin/);
    const externals = nitro.options.externals as { inline: Array<string | RegExp> };
    expect(externals.inline).toEqual(expect.arrayContaining(['own-package', '@hypdriv/']));
    expect(nitro.options.rollupConfig?.external).toBeDefined();
    const imports = nitro.options.imports as { exclude: unknown[] };
    expect(imports.exclude).toHaveLength(2);
  });

  it('does not register the plugin twice', async () => {
    const fake = fakeNitro({ major: 2 });
    await setup(fake);
    await setup(fake);
    expect(fake.nitro.options.plugins.filter((p) => /nitro2[\\/]plugin/.test(p))).toHaveLength(1);
  });

  it('serves the runtime options for the preset', async () => {
    const { nitro } = await setup(fakeNitro({ major: 2, preset: 'cloudflare-module' }), {
      framework: { host: 'analog' },
      assetPrefixes: ['/assets/', '/_analog/'],
    });
    const code = await virtual(nitro, VIRTUAL_OPTIONS);
    const options = JSON.parse(code.replace(/^export default /, '').replace(/;\s*$/, ''));
    expect(options).toEqual({
      target: 'cloudflare',
      host: 'analog',
      assetPrefixes: ['/assets/', '/_analog/'],
      nonce: true,
      socketIp: false,
    });
  });

  it('trusts the socket address on Node when no proxy is trusted', async () => {
    const { nitro } = await setup(fakeNitro({ major: 2 }));
    const code = await virtual(nitro, VIRTUAL_OPTIONS);
    expect(code).toContain('"socketIp":true');
    expect(code).toContain('"target":"node"');
  });
});

describe('Nitro 3', () => {
  it('installs the plugin first, bundles the runtime and declares cloudflare:workers', async () => {
    const { nitro } = await setup(fakeNitro({ major: 3 }));
    expect(nitro.options.plugins[0]).toMatch(/nitro3[\\/]plugin/);
    expect(nitro.options.plugins[1]).toBe('/app/plugins/own.ts');
    expect(nitro.options.noExternals).toEqual(expect.arrayContaining(['@hypdriv/']));
    expect(nitro.options.builtinModules).toEqual(['node:fs', 'cloudflare:workers']);
  });

  it('leaves noExternals alone when everything is bundled already', async () => {
    const fake = fakeNitro({ major: 3 });
    fake.nitro.options.noExternals = true;
    await setup(fake);
    expect(fake.nitro.options.noExternals).toBe(true);
  });

  it('collects the handlers from the router', async () => {
    const fake = fakeNitro({ major: 3, handlers: [{ route: '/api/hello', method: 'get' }] });
    await setup(fake);
    await fake.fire('prerender:done', { prerenderedRoutes: [] });
    await fake.fire('vite:compile:before');
    const manifest = JSON.parse(readFileSync(join(fake.root, '.hypdriv', 'manifest.json'), 'utf8')) as {
      routes: Array<{ id: string }>;
    };
    expect(manifest.routes.map((r) => r.id)).toContain('endpoint:/api/hello');
  });
});

describe('the Cloudflare Worker entry', () => {
  it('replaces the cloudflare-module entry with Hypdriv’s Worker shell (Nitro 2 imports the polyfills first)', async () => {
    const { nitro } = await setup(fakeNitro({ major: 2, preset: 'cloudflare-module' }), {
      cloudflare: { exports: 'server/worker-exports.ts' },
    });
    const entry = nitro.options.entry as string;
    expect(entry).toBe(join(nitro.options.buildDir, 'hypdriv', 'cloudflare-entry.mjs'));
    const lines = readFileSync(entry, 'utf8').trim().split('\n');
    expect(lines[0]).toBe("import '#nitro-internal-pollyfills';");
    expect(lines[1]).toMatch(/nitro2[\\/]cloudflare-worker/);
    const exportsModule = await virtual(nitro, VIRTUAL_CLOUDFLARE_EXPORTS);
    expect(exportsModule).toContain(join(nitro.options.rootDir, 'server/worker-exports.ts'));
    expect(exportsModule).toContain('HypDrivChannel');
  });

  it('uses the Nitro 3 Worker without the polyfills import', async () => {
    const { nitro } = await setup(fakeNitro({ major: 3, preset: 'cloudflare-module' }));
    const lines = readFileSync(nitro.options.entry as string, 'utf8')
      .trim()
      .split('\n');
    expect(lines[0]).toMatch(/^export \{ default \} from .*nitro3[\\/]cloudflare-worker/);
  });

  it('leaves other presets, the opt-out, the prerenderer and development alone', async () => {
    for (const fake of [
      fakeNitro({ major: 2, preset: 'vercel' }),
      fakeNitro({ major: 2, preset: 'node-server' }),
      fakeNitro({ major: 2, preset: 'cloudflare-pages' }),
      fakeNitro({ major: 2, preset: 'nitro-prerender' }),
      fakeNitro({ major: 2, preset: 'cloudflare-module', dev: true }),
    ]) {
      await setup(fake);
      expect(fake.nitro.options.entry).toBeUndefined();
    }
    const optOut = await setup(fakeNitro({ major: 2, preset: 'cloudflare-module' }), {
      cloudflare: { worker: false },
    });
    expect(optOut.nitro.options.entry).toBeUndefined();
  });

  it('warns when exports are configured for a preset without the Worker shell', async () => {
    const { messages } = await setup(fakeNitro({ major: 2, preset: 'node-server' }), {
      cloudflare: { exports: 'server/x.ts' },
    });
    expect(messages.some((m) => m.startsWith('warn:') && m.includes('cloudflare.exports'))).toBe(true);
  });
});

describe('the prerenderer and development', () => {
  it('registers the runtime for the prerender instance but no build hooks', async () => {
    const { nitro, hooks } = await setup(fakeNitro({ major: 2, preset: 'nitro-prerender' }));
    expect(nitro.options.plugins.at(-1)).toMatch(/nitro2[\\/]plugin/);
    expect(Object.keys(hooks)).toEqual([]);
    const manifest = await virtual(nitro, VIRTUAL_MANIFEST);
    expect(manifest).toContain(MANIFEST_SENTINEL_VALUE);
    expect(manifest).toContain('development');
  });

  it('serves a development manifest and aliases the runtime packages', async () => {
    const { nitro, hooks } = await setup(fakeNitro({ major: 2, preset: 'nitro-dev', dev: true }), {
      framework: { name: 'analog' },
    });
    expect(Object.keys(hooks)).toEqual([]);
    expect(Object.keys(nitro.options.alias ?? {})).toEqual(expect.arrayContaining(['@hypdriv/runtime']));
    const code = await virtual(nitro, VIRTUAL_MANIFEST);
    expect(code).toContain('analog');
    expect(existsSync(join(nitro.options.rootDir, '.hypdriv'))).toBe(false);
  });
});

describe('the build', () => {
  const html = (title: string) =>
    `<!DOCTYPE html><html><head><title>${title}</title></head><body><h1>${title}</h1><script>window.x=1</script></body></html>`;

  async function build(preset: string, major: 2 | 3 = 2) {
    const fake = fakeNitro({
      major,
      preset,
      handlers: [{ route: '/api/hello', method: 'get' }],
    });
    const { nitro } = await setup(fake, {
      routes: () => [
        { pathname: '/', kind: 'page' },
        { pathname: '/about', kind: 'page' },
        { pathname: '/dynamic', kind: 'page' },
      ],
    });
    const { publicDir, serverDir } = nitro.options.output;
    write(join(publicDir, 'index.html'), html('Home'));
    write(join(publicDir, 'about', 'index.html'), html('About'));
    write(join(publicDir, 'assets', 'main-1.js'), 'console.log(1)');
    write(
      join(publicDir, '.vite', 'manifest.json'),
      JSON.stringify({ 'index.html': { file: 'assets/main-1.js', src: 'index.html', isEntry: true } }),
    );
    await fake.fire('prerender:done', {
      prerenderedRoutes: [
        { route: '/', fileName: '/index.html', contentType: 'text/html' },
        { route: '/about', fileName: '/about/index.html', contentType: 'text/html' },
      ],
    });
    await fake.fire(major === 3 ? 'vite:compile:before' : 'rollup:before');
    // The server bundle embeds whatever the virtual manifest module returned.
    const bundled = await virtual(nitro, VIRTUAL_MANIFEST);
    const serverFile = join(serverDir, 'chunks', 'nitro.mjs');
    write(serverFile, bundled);
    return { ...fake, publicDir, serverDir, serverFile };
  }

  it('Cloudflare: embeds the final manifest and merges the hash CSP of the prerendered documents into _headers', async () => {
    const built = await build('cloudflare-module');
    const manifestInBundle = readFileSync(built.serverFile, 'utf8');
    expect(manifestInBundle).toContain('page:/about');
    expect(manifestInBundle).not.toContain('"buildId":"development"');
    await built.fire('compiled');
    const headers = readFileSync(join(built.publicDir, '_headers'), 'utf8');
    expect(headers).toMatch(/\/about\n {2}content-security-policy: [^\n]*'sha256-/);
    expect(built.messages.some((m) => m.includes('cloudflare output completed'))).toBe(true);
    expect(built.messages.some((m) => m.startsWith('warn:'))).toBe(false);
  });

  it('Node: completes the output without a static header file', async () => {
    const built = await build('node-server');
    await built.fire('compiled');
    expect(existsSync(join(built.publicDir, '_headers'))).toBe(false);
    expect(built.messages.some((m) => m.includes('node output completed'))).toBe(true);
  });

  it('Nitro 3: runs on its own hook order', async () => {
    const built = await build('node-server', 3);
    await built.fire('compiled');
    expect(built.messages.some((m) => m.includes('node output completed'))).toBe(true);
  });

  it('warns when no server file embeds the manifest', async () => {
    const fake = fakeNitro({ major: 2, preset: 'node-server' });
    await setup(fake, { routes: () => [{ pathname: '/', kind: 'page' }] });
    write(join(fake.nitro.options.output.publicDir, 'index.html'), html('Home'));
    write(join(fake.nitro.options.output.serverDir, 'index.mjs'), 'export default 1;');
    await fake.fire('prerender:done', {
      prerenderedRoutes: [{ route: '/', fileName: '/index.html', contentType: 'text/html' }],
    });
    await fake.fire('compiled');
    expect(fake.messages.some((m) => m.startsWith('warn:') && m.includes('no server file embeds'))).toBe(
      true,
    );
  });

  it('rebuilds a manifest that was finalised before the prerenderer finished', async () => {
    const fake = fakeNitro({ major: 2, preset: 'node-server' });
    await setup(fake, { routes: () => [{ pathname: '/', kind: 'page' }] });
    const { publicDir, serverDir } = fake.nitro.options.output;
    write(join(publicDir, 'index.html'), html('Home'));
    await fake.fire('rollup:before');
    const early = await virtual(fake.nitro, VIRTUAL_MANIFEST);
    write(join(serverDir, 'index.mjs'), early);
    expect(early).toMatch(/csp\\+":\{\}/);
    await fake.fire('prerender:done', {
      prerenderedRoutes: [{ route: '/', fileName: '/index.html', contentType: 'text/html' }],
    });
    await fake.fire('compiled');
    expect(readFileSync(join(serverDir, 'index.mjs'), 'utf8')).toMatch(/csp\\+":\{\\+"page:\//);
  });
});
