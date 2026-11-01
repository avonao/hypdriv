import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, installed, memoryIO, tempProject } from '../__tests__/helpers';
import { canEvaluateCloudflareConfig } from '../cloudflare-config';
import { runCommand } from '../main';
import { parseJsonc } from '../wrangler-config';
import { addToConfigArray, configObjectStart, importsModule } from './config-edit';

afterEach(cleanupProjects);

interface WranglerShape {
  name: string;
  main: string;
  assets: Record<string, unknown>;
  durable_objects: { bindings: unknown[] };
  migrations: Array<{ new_sqlite_classes: string[] }>;
}

describe('addToConfigArray', () => {
  const plugin = {
    property: 'plugins',
    element: 'hypdriv()',
    importLine: "import { hypdriv } from '@hypdriv/vite';",
    importFrom: '@hypdriv/vite',
  };

  it('appends to a single-line array and adds the import after the existing ones', () => {
    const src =
      "import react from '@vitejs/plugin-react';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [react()] });\n";
    const r = addToConfigArray(src, plugin);
    expect(r.changed).toBe(true);
    expect(r.content).toContain(
      "import { defineConfig } from 'vite';\nimport { hypdriv } from '@hypdriv/vite';\n",
    );
    expect(r.content).toContain('plugins: [hypdriv(), react()]');
    expect(addToConfigArray(r.content, plugin)).toMatchObject({ changed: false });
  });

  it('appends last in a multi-line array, keeping comments and strings with brackets', () => {
    const src = `import { defineConfig } from 'vite';
export default defineConfig({
  base: '/[x]/',
  plugins: [
    react(), // keeps ] in comments
    legacy({ targets: ['defaults'] }),
  ],
});
`;
    const r = addToConfigArray(src, { ...plugin, position: 'last' });
    expect(r.content).toContain("    legacy({ targets: ['defaults'] }),\n    hypdriv()\n  ],");
    expect(r.content).toContain("base: '/[x]/'");
  });

  it('creates the property, handles a named config object and reports what it cannot edit', () => {
    const named =
      "import { defineConfig } from 'vite';\nconst config = defineConfig({\n  base: '/',\n});\nexport default config;\n";
    expect(addToConfigArray(named, plugin).content).toContain(
      "defineConfig({\n  plugins: [hypdriv()],\n  base: '/',",
    );
    expect(addToConfigArray('export default {}', { ...plugin, importLine: undefined }).content).toBe(
      'export default {\n  plugins: [hypdriv()],\n}',
    );
    expect(addToConfigArray("module.exports = require('./x')", plugin)).toMatchObject({ changed: false });
    expect(configObjectStart('export default defineNuxtConfig({ modules: [] })')).toBe(32);
    // The function form that returns the config object (Analog's template).
    const arrow = 'export default defineConfig(({ mode }) => ({ plugins: [analog()] }));';
    expect(configObjectStart(arrow)).toBe(arrow.indexOf('({ plugins') + 1);
    expect(addToConfigArray(arrow, plugin).content).toContain('plugins: [hypdriv(), analog()]');
    expect(importsModule("import x from '@hypdriv/vite'", '@hypdriv/vite')).toBe(true);
    expect(importsModule("import x from '@hypdriv/vite/worker'", '@hypdriv/vite')).toBe(false);
  });
});

describe('hypdriv init (plain Vite)', () => {
  const pkg = JSON.stringify(
    { name: '@acme/site', private: true, devDependencies: { vite: '^8.3.5' } },
    null,
    2,
  );

  it('registers the plugins and writes the Worker, wrangler config and dependencies on Cloudflare', async () => {
    const p = tempProject({
      'package.json': pkg,
      ...installed('vite', '8.3.5'),
      'index.html': '<!doctype html><div id="app"></div>',
      'vite.config.ts': "import { defineConfig } from 'vite';\n\nexport default defineConfig({});\n",
    });
    const io = memoryIO(p.dir);
    const code = await runCommand('init', ['--platform', 'cloudflare', '--skip-doctor', '--json'], io);
    expect(code).toBe(0);
    const vite = p.read('vite.config.ts');
    expect(vite).toContain("import { cloudflare } from '@cloudflare/vite-plugin';");
    expect(vite).toContain("import { hypdriv } from '@hypdriv/vite';");
    expect(vite).toMatch(/plugins: \[cloudflare\(\), hypdriv\(\)\]/);
    expect(p.read('src/worker.ts')).toContain('assetsWorker');
    const wrangler = parseJsonc(p.read('wrangler.jsonc')) as unknown as unknown as WranglerShape;
    expect(wrangler).toMatchObject({
      name: 'acme-site',
      main: 'src/worker.ts',
      assets: { binding: 'ASSETS', not_found_handling: 'single-page-application' },
    });
    expect(wrangler.durable_objects.bindings).toHaveLength(3);
    expect(p.read('hypdriv.config.ts')).toContain("from '@hypdriv/core'");
    const json = JSON.parse(p.read('package.json'));
    expect(json.dependencies).toMatchObject({
      '@hypdriv/vite': expect.any(String),
      '@hypdriv/cloudflare': expect.any(String),
    });
    expect(json.devDependencies['@hypdriv/cli']).toBeDefined();
    expect(existsSync(join(p.dir, 'proxy.ts'))).toBe(false);
    expect(existsSync(join(p.dir, 'next.config.ts'))).toBe(false);
    const out = JSON.parse(io.out);
    expect(out.nextSteps.join('\n')).toContain('-D @cloudflare/vite-plugin wrangler');

    // Idempotent.
    const again = memoryIO(p.dir);
    await runCommand('init', ['--platform', 'cloudflare', '--skip-doctor', '--json'], again);
    const plan = JSON.parse(again.out).plan as Array<{ path: string; action: string }>;
    expect(plan.filter((i) => i.action === 'modify' || i.action === 'create')).toEqual([]);
  });

  it('adds assets and Durable Objects to an existing wrangler config and leaves Vercel builds plugin-only', async () => {
    const p = tempProject({
      'package.json': pkg,
      ...installed('vite', '8.3.5'),
      'index.html': '<!doctype html>',
      'about.html': '<!doctype html>',
      'vite.config.ts':
        "import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [] });\n",
      'wrangler.jsonc':
        '{\n  // mine\n  "name": "site",\n  "main": "src/worker.ts",\n  "compatibility_flags": ["nodejs_compat"]\n}\n',
      'src/worker.ts': 'export default { fetch() { return new Response("x") } }',
    });
    await runCommand('init', ['--platform', 'cloudflare', '--skip-doctor'], memoryIO(p.dir));
    const wrangler = parseJsonc(p.read('wrangler.jsonc')) as unknown as unknown as WranglerShape;
    expect(wrangler.assets).toMatchObject({
      not_found_handling: '404-page',
      run_worker_first: ['/*', '!/assets/*'],
    });
    expect(wrangler.migrations[0]?.new_sqlite_classes).toContain('HypDrivLimiter');
    expect(p.read('wrangler.jsonc')).toContain('// mine');
    // The existing Worker is not overwritten.
    expect(p.read('src/worker.ts')).toBe('export default { fetch() { return new Response("x") } }');

    const v = tempProject({
      'package.json': pkg,
      ...installed('vite', '8.3.5'),
      'index.html': '<!doctype html>',
    });
    await runCommand('init', ['--platform', 'vercel', '--skip-doctor'], memoryIO(v.dir));
    expect(v.read('vite.config.ts')).toContain('plugins: [hypdriv()]');
    expect(existsSync(join(v.dir, 'wrangler.jsonc'))).toBe(false);
    expect(existsSync(join(v.dir, 'src/worker.ts'))).toBe(false);

    const n = tempProject({
      'package.json': pkg,
      ...installed('vite', '8.3.5'),
      'index.html': '<!doctype html>',
    });
    await runCommand('init', ['--platform', 'node', '--skip-doctor'], memoryIO(n.dir));
    expect(JSON.parse(n.read('package.json')).scripts.start).toBe('hypdriv serve');
  });
});

describe('hypdriv init (Astro)', () => {
  it('registers the integration and writes the Worker shell on Cloudflare', async () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'blog', dependencies: { astro: '^7.4.4' } }),
      ...installed('astro', '7.4.4'),
      'astro.config.mjs':
        "import cloudflare from '@astrojs/cloudflare';\nimport { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  adapter: cloudflare(),\n  integrations: [],\n});\n",
    });
    const io = memoryIO(p.dir);
    await runCommand('init', ['--platform', 'cloudflare', '--skip-doctor', '--json'], io);
    const config = p.read('astro.config.mjs');
    expect(config).toContain("import hypdriv from '@hypdriv/astro';");
    expect(config).toContain('integrations: [hypdriv()]');
    expect(p.read('src/worker.ts')).toContain("from '@astrojs/cloudflare/handler'");
    const wrangler = parseJsonc(p.read('wrangler.jsonc')) as unknown as WranglerShape;
    expect(wrangler.assets).toMatchObject({ run_worker_first: ['/*', '!/_astro/*'] });
    expect(JSON.parse(p.read('package.json')).dependencies['@hypdriv/astro']).toBeDefined();
    expect(JSON.parse(io.out).notes).toEqual([]);
  });

  it('asks for an adapter and static headers on Node', async () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'blog', dependencies: { astro: '^7.4.4' } }),
      ...installed('astro', '7.4.4'),
      'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",
    });
    const io = memoryIO(p.dir);
    await runCommand('init', ['--platform', 'node', '--skip-doctor', '--json'], io);
    const notes = JSON.parse(io.out).notes.join('\n');
    expect(notes).toContain('staticHeaders: true');
    expect(notes).toContain('adapter');
    expect(p.read('astro.config.mjs')).toContain('integrations: [hypdriv()]');
  });
});

describe('config editors for framework wiring', () => {
  it('wraps a call argument and a property value', async () => {
    const { wrapCallArgument, wrapPropertyValue } = await import('./config-edit');
    const start = `import { tanstackStart } from '@tanstack/react-start/plugin/vite';\nexport default defineConfig({ plugins: [tanstackStart({ prerender: { enabled: true } }), viteReact()] });\n`;
    const wrapped = wrapCallArgument(start, {
      callee: 'tanstackStart',
      wrapper: 'withHypDriv',
      importLine: "import { withHypDriv } from '@hypdriv/tanstack-start/vite';",
      importFrom: '@hypdriv/tanstack-start/vite',
    });
    expect(wrapped.content).toContain(
      'tanstackStart(withHypDriv({ prerender: { enabled: true } })), viteReact()',
    );
    expect(wrapped.content).toContain("import { withHypDriv } from '@hypdriv/tanstack-start/vite';");
    expect(
      wrapCallArgument(wrapped.content, {
        callee: 'tanstackStart',
        wrapper: 'withHypDriv',
        importLine: '',
        importFrom: 'x',
      }).changed,
    ).toBe(false);
    expect(
      wrapCallArgument('x(tanstackStart())', {
        callee: 'tanstackStart',
        wrapper: 'withHypDriv',
        importLine: 'import w from "w";',
        importFrom: 'w',
      }).content,
    ).toContain('tanstackStart(withHypDriv())');
    const kit = `import adapter from '@sveltejs/adapter-node';\nexport default defineConfig({ plugins: [sveltekit({ adapter: adapter({ out: 'build' }), csp: { mode: 'auto' } })] });\n`;
    const k = wrapPropertyValue(kit, {
      property: 'adapter',
      within: 'sveltekit',
      wrapper: 'hypdriv',
      importLine: "import { hypdriv } from '@hypdriv/sveltekit';",
      importFrom: '@hypdriv/sveltekit',
    });
    expect(k.content).toContain("adapter: hypdriv(adapter({ out: 'build' })), csp:");
    expect(k.content).toContain("import { hypdriv } from '@hypdriv/sveltekit';");
  });

  it('inserts before an anchor element', () => {
    const r = addToConfigArray('export default defineConfig({ plugins: [vinext(), tail()] });', {
      property: 'plugins',
      element: 'cloudflare()',
      before: /tail\s*\(/,
    });
    expect(r.content).toContain('plugins: [vinext(), cloudflare(), tail()]');
  });
});

describe('hypdriv init for framework hosts', () => {
  async function init(files: Record<string, string>, platform: string) {
    const p = tempProject(files);
    const io = memoryIO(p.dir);
    expect(await runCommand('init', ['--platform', platform, '--skip-doctor', '--json'], io)).toBe(0);
    return {
      p,
      out: JSON.parse(io.out) as {
        plan: Array<{ path: string; action: string; hint?: string }>;
        notes: string[];
      },
    };
  }

  it('React Router: plugin before reactRouter(), preset, root middleware, server entry, Worker', async () => {
    const { p } = await init(
      {
        'package.json': JSON.stringify({ name: 'rr', devDependencies: { '@react-router/dev': '^8.5.1' } }),
        ...installed('@react-router/dev', '8.5.1'),
        'vite.config.ts':
          "import { reactRouter } from '@react-router/dev/vite';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [reactRouter()] });\n",
        'react-router.config.ts':
          "import type { Config } from '@react-router/dev/config';\nexport default { ssr: true } satisfies Config;\n",
        'app/root.tsx':
          "import { Outlet } from 'react-router';\nexport default function App() { return <Outlet />; }\n",
      },
      'cloudflare',
    );
    expect(p.read('vite.config.ts')).toMatch(
      /plugins: \[cloudflare\(\{ viteEnvironment: \{ name: 'ssr' \} \}\), hypdriv\(\), reactRouter\(\)\]/,
    );
    expect(p.read('react-router.config.ts')).toContain('presets: [hypdrivPreset()]');
    expect(p.read('app/root.tsx')).toContain('export const middleware = [hypdrivMiddleware()];');
    expect(p.read('app/entry.server.tsx')).toContain('@hypdriv/react-router/entry.server');
    expect(p.read('workers/app.ts')).toContain('reactRouterWorker');
    expect(parseJsonc(p.read('wrangler.jsonc'))).toMatchObject({ main: 'workers/app.ts' });
  });

  it('TanStack Start: withHypDriv(), hypdriv() last, nitro before it, start.ts', async () => {
    const { p, out } = await init(
      {
        'package.json': JSON.stringify({ name: 'ts', dependencies: { '@tanstack/react-start': '^1.169.4' } }),
        ...installed('@tanstack/react-start', '1.169.4'),
        'vite.config.ts':
          "import { tanstackStart } from '@tanstack/react-start/plugin/vite';\nimport viteReact from '@vitejs/plugin-react';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [tanstackStart(), viteReact()] });\n",
      },
      'vercel',
    );
    const vite = p.read('vite.config.ts');
    expect(vite).toContain('tanstackStart(withHypDriv()), viteReact(), nitro(), hypdriv()');
    expect(p.read('src/start.ts')).toContain('hypdrivRequestMiddleware');
    expect(out.notes.join('\n')).toContain('hypdrivSsr');
  });

  it('SvelteKit, Nuxt and vinext register where their config expects it', async () => {
    const kit = await init(
      {
        'package.json': JSON.stringify({ name: 'kit', devDependencies: { '@sveltejs/kit': '^3.1.1' } }),
        ...installed('@sveltejs/kit', '3.1.1'),
        'vite.config.ts':
          "import adapter from '@sveltejs/adapter-node';\nimport { sveltekit } from '@sveltejs/kit/vite';\nexport default defineConfig({ plugins: [sveltekit({ adapter: adapter() })] });\n",
      },
      'node',
    );
    expect(kit.p.read('vite.config.ts')).toContain('adapter: hypdriv(adapter())');
    expect(kit.p.read('src/hooks.server.ts')).toContain('export const handle = hypdriv();');
    expect(kit.p.read('server.js')).toContain('@hypdriv/sveltekit/node');
    expect(JSON.parse(kit.p.read('package.json')).scripts.start).toBe('node server.js');

    const nuxt = await init(
      {
        'package.json': JSON.stringify({ name: 'nx', dependencies: { nuxt: '^4.6.3' } }),
        ...installed('nuxt', '4.6.3'),
        'nuxt.config.ts': "export default defineNuxtConfig({ modules: ['@nuxt/image'] });\n",
      },
      'cloudflare',
    );
    expect(nuxt.p.read('nuxt.config.ts')).toContain("modules: ['@nuxt/image', '@hypdriv/nuxt']");
    expect(parseJsonc(nuxt.p.read('wrangler.jsonc'))).toMatchObject({
      assets: { html_handling: 'drop-trailing-slash' },
    });
    expect(nuxt.out.notes.join('\n')).toContain('cloudflare-module');

    const vinext = await init(
      {
        'package.json': JSON.stringify({ name: 'vx', dependencies: { vinext: '^1.4.0' } }),
        ...installed('vinext', '1.4.0'),
        'vite.config.ts':
          "import vinext from 'vinext';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [vinext()] });\n",
      },
      'cloudflare',
    );
    expect(vinext.p.read('vite.config.ts')).toMatch(
      /plugins: \[vinext\(\), cloudflare\(\{ viteEnvironment: \{ name: 'rsc', childEnvironments: \['ssr'\] \} \}\), hypdriv\(\)\]/,
    );
    expect(vinext.p.read('worker/index.ts')).toContain('createVinextWorker');
  });
  it('Hono: useHypDriv() after the app, the config import, the Durable Objects and the wrangler settings', async () => {
    const { p, out } = await init(
      {
        'package.json': JSON.stringify({ name: 'api', dependencies: { hono: '^4.13.16' } }),
        ...installed('hono', '4.13.16'),
        'src/index.ts':
          "import { Hono } from 'hono';\n\nconst app = new Hono();\n\napp.get('/', (c) => c.text('hi'));\n\nexport default app;\n",
      },
      'cloudflare',
    );
    const entry = p.read('src/index.ts');
    expect(entry).toContain("import { useHypDriv } from '@hypdriv/hono';");
    expect(entry).toContain("import config from '../hypdriv.config';");
    expect(entry.indexOf('useHypDriv(app, { config });')).toBeLessThan(entry.indexOf("app.get('/'"));
    expect(entry).toContain(
      "export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';",
    );
    expect(parseJsonc(p.read('wrangler.jsonc'))).toMatchObject({ main: 'src/index.ts' });
    expect(out.plan.find((i) => i.path === 'src/index.ts')?.action).toBe('modify');
  });

  it('Hono: a chained app is left to the user with the exact snippet, a new project gets an entry', async () => {
    const chained = await init(
      {
        'package.json': JSON.stringify({ name: 'api', dependencies: { hono: '^4.13.16' } }),
        ...installed('hono', '4.13.16'),
        'src/index.ts':
          "import { Hono } from 'hono';\nconst app = new Hono()\n  .get('/', (c) => c.text('hi'));\nexport default app;\n",
      },
      'vercel',
    );
    expect(chained.out.plan.find((i) => i.path === 'src/index.ts')?.action).toBe('manual');
    expect(chained.p.read('src/index.ts')).not.toContain('useHypDriv');

    const fresh = await init(
      {
        'package.json': JSON.stringify({ name: 'api', dependencies: { hono: '^4.13.16' } }),
        ...installed('hono', '4.13.16'),
      },
      'node',
    );
    const created = fresh.p.read('src/index.ts');
    expect(created).toContain('useHypDriv(app, { config });');
    expect(created).toContain('serve({ fetch: app.fetch');
    expect(created).not.toContain('durable-objects');
  });

  it.skipIf(!canEvaluateCloudflareConfig())(
    'Hono on a cf CLI project: reads cloudflare.config.ts, never edits it, and prints the missing settings',
    async () => {
      const files = {
        'package.json': JSON.stringify({ name: 'api', type: 'module', dependencies: { hono: '^4.13.16' } }),
        ...installed('hono', '4.13.16'),
        'src/index.ts':
          "import { Hono } from 'hono';\n\nconst app = new Hono();\napp.get('/', (c) => c.text('hi'));\nexport default app;\n",
        'cloudflare.config.ts': `import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
export default defineConfig({ worker: { name: "api", entrypoint, compatibilityDate: "2026-09-01" } });
`,
      };
      const first = await init(files, 'cloudflare');
      expect(first.p.read('cloudflare.config.ts')).toBe(files['cloudflare.config.ts']);
      expect(existsSync(join(first.p.dir, 'wrangler.jsonc'))).toBe(false);
      const item = first.out.plan.find((i) => i.path === 'cloudflare.config.ts');
      expect(item).toMatchObject({ action: 'manual' });
      expect(item?.hint).toContain('compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"]');
      expect(item?.hint).toContain('observability: { enabled: true }');
      expect(item?.hint).toContain('HypDrivChannel: exports.durableObject({ storage: "sqlite" })');
      expect(item?.hint).toContain('HYPDRIV_LIMITER: bindings.durableObject(');
      expect(item?.hint).not.toContain('entrypoint:');

      // A config that already has everything needs nothing.
      const complete = await init(
        {
          ...files,
          'cloudflare.config.ts': `import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
export default defineConfig({
  worker: {
    name: "api",
    entrypoint,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    observability: { enabled: true },
    env: {
      HYPDRIV_LIMITER: bindings.durableObject({ worker: "api", exportName: "HypDrivLimiter" }),
      HYPDRIV_INDEX: bindings.durableObject({ worker: "api", exportName: "HypDrivIndex" }),
      HYPDRIV_CHANNEL: bindings.durableObject({ worker: "api", exportName: "HypDrivChannel" }),
    },
    exports: {
      HypDrivLimiter: exports.durableObject({ storage: "sqlite" }),
      HypDrivIndex: exports.durableObject({ storage: "sqlite" }),
      HypDrivChannel: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
`,
        },
        'cloudflare',
      );
      expect(complete.out.plan.find((i) => i.path === 'cloudflare.config.ts')).toMatchObject({
        action: 'skip',
      });
    },
  );

  const waku = {
    'package.json': JSON.stringify({ name: 'wk', dependencies: { waku: '1.0.0-rc.4', hono: '^4.12.14' } }),
    ...installed('waku', '1.0.0-rc.4'),
  };

  it('Waku: withHypDriv() around the config, cloudflare() on the rsc environment and the Worker settings', async () => {
    const { p, out } = await init(
      {
        ...waku,
        'waku.config.ts':
          "import { defineConfig } from 'waku/config';\n\nexport default defineConfig({\n  basePath: '/',\n});\n",
      },
      'cloudflare',
    );
    const config = p.read('waku.config.ts');
    expect(config).toContain("import { withHypDriv } from '@hypdriv/waku';");
    expect(config).toContain("import { cloudflare } from '@cloudflare/vite-plugin';");
    expect(config).toContain('defineConfig(withHypDriv({');
    expect(config).toContain("cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } })");
    expect(config).toContain("basePath: '/'");
    const wrangler = parseJsonc(p.read('wrangler.jsonc')) as unknown as WranglerShape;
    expect(wrangler).toMatchObject({
      main: './src/waku.server',
      assets: { directory: './dist/public', run_worker_first: ['/*', '!/assets/*'] },
    });
    expect(wrangler.durable_objects.bindings).toHaveLength(3);
    expect(out.plan.find((i) => i.path === 'waku.config.ts')?.action).toBe('modify');
    // Waku's own server file is not needed: the plugin exports the Durable Objects from the managed entry.
    expect(existsSync(join(p.dir, 'src', 'waku.server.tsx'))).toBe(false);
    const pkg = JSON.parse(p.read('package.json')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies['@hypdriv/waku']).toBeDefined();
    expect(pkg.scripts['hypdriv:audit']).toContain('8787');
  });

  it('Waku: a config that already has vite.plugins or a vite object gets the Cloudflare plugin there', async () => {
    const withPlugins = await init(
      {
        ...waku,
        'waku.config.ts':
          "import { defineConfig } from 'waku/config';\nimport tailwind from '@tailwindcss/vite';\n\nexport default defineConfig({\n  vite: { plugins: [tailwind()] },\n});\n",
      },
      'cloudflare',
    );
    expect(withPlugins.p.read('waku.config.ts')).toMatch(/plugins: \[cloudflare\(.*\), tailwind\(\)\]/);

    const withVite = await init(
      {
        ...waku,
        'waku.config.ts':
          "import { defineConfig } from 'waku/config';\n\nexport default defineConfig({\n  vite: { resolve: { alias: {} } },\n});\n",
      },
      'cloudflare',
    );
    expect(withVite.p.read('waku.config.ts')).toContain('plugins: [cloudflare(');
  });

  it('Waku: Vercel and Node need no plugin, a new project gets waku.config.ts, an unwrappable config a snippet', async () => {
    const vercel = await init(
      {
        ...waku,
        'waku.config.ts': "import { defineConfig } from 'waku/config';\nexport default defineConfig({});\n",
      },
      'vercel',
    );
    expect(vercel.p.read('waku.config.ts')).toContain('defineConfig(withHypDriv({}))');
    expect(vercel.p.read('waku.config.ts')).not.toContain('cloudflare');
    expect(existsSync(join(vercel.p.dir, 'wrangler.jsonc'))).toBe(false);

    const fresh = await init(waku, 'node');
    expect(fresh.p.read('waku.config.ts')).toContain('export default defineConfig(\n  withHypDriv({}),\n);');
    expect(JSON.parse(fresh.p.read('package.json')).scripts.start).toBe('waku start --port 3000');
    expect(fresh.out.notes.join('\n')).toContain('dist/serve-node.js');

    const plain = await init({ ...waku, 'waku.config.ts': 'export default { basePath: "/" };\n' }, 'node');
    expect(plain.out.plan.find((i) => i.path === 'waku.config.ts')?.action).toBe('manual');
    expect(plain.p.read('waku.config.ts')).not.toContain('withHypDriv');
  });

  it('Waku: an existing wrangler config keeps its name and gets the missing settings', async () => {
    const { p } = await init(
      {
        ...waku,
        'waku.config.ts': "import { defineConfig } from 'waku/config';\nexport default defineConfig({});\n",
        'wrangler.jsonc':
          '{\n  "name": "my-waku",\n  "main": "./src/waku.server",\n  "compatibility_date": "2026-10-01",\n  "compatibility_flags": ["nodejs_compat"]\n}\n',
      },
      'cloudflare',
    );
    const wrangler = parseJsonc(p.read('wrangler.jsonc')) as unknown as WranglerShape;
    expect(wrangler.name).toBe('my-waku');
    expect(wrangler.main).toBe('./src/waku.server');
    expect(wrangler.durable_objects.bindings).toHaveLength(3);
  });

  const nitro2 = {
    'package.json': JSON.stringify({ name: 'api', dependencies: { nitropack: '^2.13.5' } }),
    ...installed('nitropack', '2.13.5'),
  };

  it('Nitro 2: hypdrivNitro() in the modules of nitro.config and Worker settings for the generated entry', async () => {
    const { p, out } = await init(
      {
        ...nitro2,
        'nitro.config.ts':
          "import { defineNitroConfig } from 'nitropack/config';\n\nexport default defineNitroConfig({\n  srcDir: 'server',\n});\n",
      },
      'cloudflare',
    );
    const config = p.read('nitro.config.ts');
    expect(config).toContain("import { hypdrivNitro } from '@hypdriv/nitro';");
    expect(config).toContain('modules: [hypdrivNitro()]');
    expect(parseJsonc(p.read('wrangler.jsonc'))).toMatchObject({
      assets: { html_handling: 'drop-trailing-slash', run_worker_first: ['/*', '!/assets/*'] },
      durable_objects: { bindings: expect.any(Array) },
    });
    expect(out.notes.join('\n')).toContain('cloudflare-module');
    expect(JSON.parse(p.read('package.json')).dependencies['@hypdriv/nitro']).toBeDefined();

    // Idempotent: nothing left to create or modify.
    const again = memoryIO(p.dir);
    await runCommand('init', ['--platform', 'cloudflare', '--skip-doctor', '--json'], again);
    const plan = JSON.parse(again.out).plan as Array<{ action: string }>;
    expect(plan.filter((i) => i.action === 'modify' || i.action === 'create')).toEqual([]);
  });

  it('Nitro: creates nitro.config for Nitro 2 or 3 and starts Node builds from .output', async () => {
    const two = await init(nitro2, 'node');
    expect(two.p.read('nitro.config.ts')).toContain("from 'nitropack/config'");
    expect(two.p.read('nitro.config.ts')).toContain('modules: [hypdrivNitro()]');
    expect(JSON.parse(two.p.read('package.json')).scripts.start).toBe('node .output/server/index.mjs');
    expect(existsSync(join(two.p.dir, 'wrangler.jsonc'))).toBe(false);

    const three = await init(
      {
        'package.json': JSON.stringify({ name: 'api3', dependencies: { nitro: '3.0.261029-rc' } }),
        ...installed('nitro', '3.0.261029-rc'),
      },
      'node',
    );
    expect(three.p.read('nitro.config.ts')).toContain("import { defineConfig } from 'nitro';");
  });

  it('Nitro 3 on Vite: the plugin from @hypdriv/nitro/vite after nitro() in vite.config', async () => {
    const { p } = await init(
      {
        'package.json': JSON.stringify({
          name: 'api3',
          dependencies: { nitro: '3.0.261029-rc' },
          devDependencies: { vite: '^8.3.5' },
        }),
        ...installed('nitro', '3.0.261029-rc'),
        'vite.config.ts':
          "import { nitro } from 'nitro/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [nitro()] });\n",
      },
      'vercel',
    );
    const vite = p.read('vite.config.ts');
    expect(vite).toContain("import { hypdriv } from '@hypdriv/nitro/vite';");
    expect(vite).toContain('plugins: [nitro(), hypdriv()]');
    expect(existsSync(join(p.dir, 'nitro.config.ts'))).toBe(false);
  });

  const analog = {
    'package.json': JSON.stringify({
      name: 'ng',
      dependencies: { '@analogjs/platform': '^2.9.4', nitropack: '^2.13.5' },
      devDependencies: { vite: '^8.3.5' },
    }),
    ...installed('@analogjs/platform', '2.9.4'),
  };

  it('Analog: withHypDriv() around analog(), hypdriv() plugin, provideHypDriv() in the server config', async () => {
    const { p, out } = await init(
      {
        ...analog,
        'vite.config.ts': `import analog from '@analogjs/platform';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  build: { target: ['es2020'] },
  plugins: [analog()],
  define: { 'import.meta.vitest': mode !== 'production' },
}));
`,
        'src/app/app.config.server.ts': `import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/platform-server';
import { appConfig } from './app.config';

const serverConfig: ApplicationConfig = {
  providers: [provideServerRendering()],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
`,
      },
      'cloudflare',
    );
    const vite = p.read('vite.config.ts');
    expect(vite).toContain("import { hypdriv, withHypDriv } from '@hypdriv/analog';");
    expect(vite).toContain('plugins: [analog(withHypDriv()), hypdriv()]');
    expect(p.read('src/app/app.config.server.ts')).toContain(
      'providers: [provideServerRendering(), provideHypDriv()]',
    );
    expect(p.read('src/app/app.config.server.ts')).toContain(
      "import { provideHypDriv } from '@hypdriv/analog/angular/server';",
    );
    expect(parseJsonc(p.read('wrangler.jsonc'))).toMatchObject({
      assets: { run_worker_first: ['/*', '!/assets/*'] },
    });
    const notes = out.notes.join('\n');
    expect(notes).toContain('deployConfig: true');
    expect(notes).toContain('TransferState');

    // Idempotent.
    const again = memoryIO(p.dir);
    await runCommand('init', ['--platform', 'cloudflare', '--skip-doctor', '--json'], again);
    const plan = JSON.parse(again.out).plan as Array<{ action: string }>;
    expect(plan.filter((i) => i.action === 'modify' || i.action === 'create')).toEqual([]);
  });

  it('Analog: keeps the options of analog(), starts Node builds from dist/analog and hints when the server config is missing', async () => {
    const { p, out } = await init(
      {
        ...analog,
        'vite.config.ts':
          "import analog from '@analogjs/platform';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [analog({ ssr: true, prerender: { routes: ['/'] } })] });\n",
      },
      'node',
    );
    expect(p.read('vite.config.ts')).toContain(
      "analog(withHypDriv({ ssr: true, prerender: { routes: ['/'] } })), hypdriv()",
    );
    expect(JSON.parse(p.read('package.json')).scripts.start).toBe('node dist/analog/server/index.mjs');
    expect(out.plan.find((i) => i.path === 'src/app/app.config.server.ts')?.action).toBe('manual');
  });
});
