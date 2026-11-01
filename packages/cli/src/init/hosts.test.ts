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
    expect(importsModule("import x from '@hypdriv/vite'", '@hypdriv/vite')).toBe(true);
    expect(importsModule("import x from '@hypdriv/vite/worker'", '@hypdriv/vite')).toBe(false);
  });

  it('edits the object a function-form config returns', () => {
    const last = { ...plugin, position: 'last' as const };
    // The Qwik starter: a block body with a typed return.
    const block = `import { defineConfig, type UserConfig } from 'vite';

export default defineConfig(({ command, mode }): UserConfig => {
  const dev = command === 'serve';
  return {
    plugins: [qwikRouter(), qwikVite(), tsconfigPaths({ root: '.' })],
    server: { headers: { 'Cache-Control': 'public, max-age=0' } },
  };
});
`;
    const edited = addToConfigArray(block, last);
    expect(edited.changed).toBe(true);
    expect(edited.content).toContain("tsconfigPaths({ root: '.' }), hypdriv()]");
    expect(edited.content).toContain("import { hypdriv } from '@hypdriv/vite';");

    // An expression body, an async function expression and a parameter without parentheses.
    expect(
      addToConfigArray('export default defineConfig(({ mode }) => ({ plugins: [react()] }));', last).content,
    ).toContain('plugins: [react(), hypdriv()]');
    expect(
      addToConfigArray(
        'export default defineConfig(async function () {\n  const x = await load();\n  return { plugins: [] };\n});',
        last,
      ).content,
    ).toContain('plugins: [hypdriv()]');
    expect(addToConfigArray('export default defineConfig(env => ({ base: "/" }));', last).content).toContain(
      'plugins: [hypdriv()]',
    );

    // The return of a nested function is not the config.
    const nested =
      'export default defineConfig(() => {\n  const f = () => { return { a: 1 }; };\n  return { plugins: [] };\n});';
    const nestedEdit = addToConfigArray(nested, last).content;
    expect(nestedEdit).toContain('return { plugins: [hypdriv()] }');
    expect(nestedEdit).toContain('return { a: 1 }');

    // Nothing to edit when the function does not return an object literal.
    expect(addToConfigArray('export default defineConfig(() => buildConfig());', last)).toMatchObject({
      changed: false,
      reason: 'no exported config object found',
    });
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

  const qwik = {
    'package.json': JSON.stringify({
      name: 'qk',
      devDependencies: { '@qwik.dev/core': '2.0.0-rc.4', '@qwik.dev/router': '2.0.0-rc.4', vite: '^8.3.5' },
    }),
    ...installed('@qwik.dev/core', '2.0.0-rc.4'),
    ...installed('@qwik.dev/router', '2.0.0-rc.4'),
    'vite.config.ts':
      "import { qwikVite } from '@qwik.dev/core/optimizer';\nimport { qwikRouter } from '@qwik.dev/router/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [qwikRouter(), qwikVite()],\n});\n",
    'src/entry.ssr.tsx': 'export default null;\n',
  };

  it('Qwik: hypdriv() after qwikVite(), the Cloudflare adapter and entry, and the Worker settings', async () => {
    const { p, out } = await init(qwik, 'cloudflare');
    const config = p.read('vite.config.ts');
    expect(config).toContain("import { hypdriv } from '@hypdriv/qwik';");
    expect(config).toContain('plugins: [qwikRouter(), qwikVite(), hypdriv()]');
    expect(p.read('adapters/cloudflare/vite.config.ts')).toContain(
      "import { cloudflareAdapter } from '@hypdriv/qwik/adapters/cloudflare';",
    );
    expect(p.read('adapters/cloudflare/vite.config.ts')).toContain("input: ['src/entry.cloudflare.tsx']");
    expect(p.read('src/entry.cloudflare.tsx')).toContain(
      "import { createQwikRouter } from '@hypdriv/qwik/middleware/cloudflare';",
    );
    const wrangler = parseJsonc(p.read('wrangler.jsonc')) as unknown as WranglerShape;
    expect(wrangler).toMatchObject({
      main: './dist/_worker.js',
      assets: { directory: './dist', run_worker_first: ['/*', '!/build/*', '!/assets/*'] },
    });
    expect(wrangler.durable_objects.bindings).toHaveLength(3);
    // Route loader data is application data that looks like a file: the Cloudflare config runs the pipeline for it.
    expect(p.read('hypdriv.config.ts')).toContain('skipStaticAssets: false');
    const pkg = JSON.parse(p.read('package.json')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies['@hypdriv/qwik']).toBeDefined();
    expect(pkg.scripts['build:cloudflare']).toBe(
      'vite build && vite build -c adapters/cloudflare/vite.config.ts',
    );
    expect(pkg.scripts['hypdriv:audit']).toContain('8787');
    expect(out.plan.find((i) => i.path === 'vite.config.ts')?.action).toBe('modify');
  });

  it('Qwik: the Vercel adapter builds into the Build Output, Node gets a server entry and a start script', async () => {
    const vercel = await init(qwik, 'vercel');
    expect(vercel.p.read('adapters/vercel/vite.config.ts')).toContain(
      "outDir: '.vercel/output/functions/_qwik-router.func'",
    );
    expect(vercel.p.read('src/entry.vercel.tsx')).toContain('export default createQwikRouter({ render });');
    expect(existsSync(join(vercel.p.dir, 'wrangler.jsonc'))).toBe(false);
    expect(vercel.out.notes.join('\n')).toContain('.vercel/output');

    const node = await init(qwik, 'node');
    expect(node.p.read('src/entry.node.tsx')).toContain("from '@hypdriv/qwik/middleware/node'");
    expect(node.p.read('src/entry.node.tsx')).toContain('createServer(listener)');
    expect(JSON.parse(node.p.read('package.json')).scripts.start).toBe('node server/entry.node.js');
    expect(node.p.read('hypdriv.config.ts')).toContain('skipStaticAssets: false');
    expect(node.out.notes.join('\n')).toContain('server/entry.node.js');
  });

  it('Qwik: files that exist are not overwritten, and Qwik’s own adapters are called out', async () => {
    const { p, out } = await init(
      {
        ...qwik,
        'vite.config.ts':
          "import { hypdriv } from '@hypdriv/qwik';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [hypdriv()] });\n",
        'adapters/node-server/vite.config.ts':
          "import { nodeServerAdapter } from '@qwik.dev/router/adapters/node-server/vite';\n",
        'adapters/node/vite.config.ts': 'export default {};\n',
        'src/entry.node.tsx': "import { createQwikRouter } from '@qwik.dev/router/middleware/node';\n",
      },
      'node',
    );
    expect(p.read('adapters/node/vite.config.ts')).toBe('export default {};\n');
    expect(p.read('src/entry.node.tsx')).toContain('@qwik.dev/router/middleware/node');
    expect(out.plan.find((i) => i.path === 'vite.config.ts')?.action).toBe('skip');
    expect(out.plan.find((i) => i.path === 'adapters/node/vite.config.ts')?.action).toBe('manual');
    expect(out.plan.find((i) => i.path === 'src/entry.node.tsx')?.action).toBe('manual');
    expect(out.notes.join('\n')).toContain("adapters/node-server use Qwik's own adapter");
  });

  it('Qwik: registers hypdriv() in the starter’s function-form vite.config', async () => {
    const { p, out } = await init(
      {
        ...qwik,
        'vite.config.ts': `import { qwikVite } from "@qwik.dev/core/optimizer";
import { qwikRouter } from "@qwik.dev/router/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ command, mode }): UserConfig => {
  return {
    plugins: [qwikRouter(), qwikVite(), tsconfigPaths({ root: "." })],
    optimizeDeps: { exclude: [] },
  };
});
`,
      },
      'node',
    );
    expect(out.plan.find((i) => i.path === 'vite.config.ts')?.action).toBe('modify');
    expect(p.read('vite.config.ts')).toContain('tsconfigPaths({ root: "." }), hypdriv()]');
    expect(p.read('vite.config.ts')).toContain("import { hypdriv } from '@hypdriv/qwik';");
  });

  it('Qwik: a Qwik v1 project gets no edits, only the move to v2', async () => {
    const { p, out } = await init(
      {
        'package.json': JSON.stringify({
          name: 'qk1',
          devDependencies: { '@builder.io/qwik-city': '1.20.3' },
        }),
        ...installed('@builder.io/qwik-city', '1.20.3'),
        'vite.config.ts':
          "import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [] });\n",
      },
      'node',
    );
    const item = out.plan.find((i) => i.path === 'vite.config.ts');
    expect(item?.action).toBe('manual');
    expect(p.read('vite.config.ts')).not.toContain('hypdriv');
    expect(existsSync(join(p.dir, 'adapters'))).toBe(false);
    expect(JSON.stringify(out.plan)).toContain('qwik migrate-v2');
  });
});
