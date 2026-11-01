import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, installed, memoryIO, tempProject } from '../__tests__/helpers';
import { canEvaluateCloudflareConfig } from '../cloudflare-config';
import { runCommand } from '../main';
import { parseJsonc } from '../wrangler-config';
import { addToConfigArray, configObjectStart, importsModule } from './config-edit';
import { addHypdrivStart, wrapRwsdkApp } from './hosts';

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

  const rwsdk = {
    'package.json': JSON.stringify({
      name: 'rw',
      dependencies: { rwsdk: '1.7.5' },
      devDependencies: { vite: '^8.3.5' },
    }),
    ...installed('rwsdk', '1.7.5'),
    'vite.config.mts': `import { cloudflare } from '@cloudflare/vite-plugin';
import { redwood } from 'rwsdk/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  environments: { ssr: {} },
  plugins: [cloudflare({ viteEnvironment: { name: 'worker' } }), redwood()],
});
`,
    'src/worker.tsx': `import { render, route } from 'rwsdk/router';
import { defineApp } from 'rwsdk/worker';
import { Document } from '@/app/Document';
import { Home } from '@/app/pages/Home';

export default defineApp([
  render(Document, [route('/', Home)]),
]);
`,
    'wrangler.jsonc':
      '{\n  "name": "my-rw",\n  "main": "src/worker.tsx",\n  "compatibility_date": "2026-10-01",\n  "compatibility_flags": ["nodejs_compat"],\n  "assets": { "binding": "ASSETS" }\n}\n',
  };

  it('RedwoodSDK: hypdriv() after redwood(), the Worker wrapped with the nonce middleware first, the Worker settings', async () => {
    const { p, out } = await init(rwsdk, 'cloudflare');
    const config = p.read('vite.config.mts');
    expect(config).toContain("import { hypdriv } from '@hypdriv/rwsdk';");
    expect(config).toContain(
      "plugins: [cloudflare({ viteEnvironment: { name: 'worker' } }), redwood(), hypdriv()]",
    );
    const worker = p.read('src/worker.tsx');
    expect(worker).toContain("import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';");
    expect(worker).toContain(
      'export default withHypDriv(defineApp([\n  hypdrivMiddleware(),\n  render(Document',
    );
    expect(worker.match(/hypdrivMiddleware\(\)/g)).toHaveLength(1);
    const wrangler = parseJsonc(p.read('wrangler.jsonc')) as unknown as WranglerShape;
    expect(wrangler.name).toBe('my-rw');
    expect(wrangler.durable_objects.bindings).toHaveLength(3);
    expect(wrangler.migrations[0]?.new_sqlite_classes).toContain('HypDrivLimiter');
    expect(out.plan.find((i) => i.path === 'vite.config.mts')?.action).toBe('modify');
    expect(out.plan.find((i) => i.path === 'src/worker.tsx')?.action).toBe('modify');
    expect(out.notes.join('\n')).toContain('run_worker_first');
    expect(out.notes.join('\n')).toContain('exports the Durable Object classes');
    const pkg = JSON.parse(p.read('package.json')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies['@hypdriv/rwsdk']).toBeDefined();
    expect(pkg.scripts['hypdriv:audit']).toContain('4173');
    // A second run changes nothing.
    const again = await init({ ...rwsdk, 'vite.config.mts': config, 'src/worker.tsx': worker }, 'cloudflare');
    expect(again.out.plan.find((i) => i.path === 'vite.config.mts')?.action).toBe('skip');
    expect(again.out.plan.find((i) => i.path === 'src/worker.tsx')?.action).toBe('skip');
  });

  it('RedwoodSDK: a project without a Vite config or a Wrangler config gets both', async () => {
    const { p } = await init(
      {
        'package.json': rwsdk['package.json'],
        ...installed('rwsdk', '1.7.5'),
        'src/worker.tsx': rwsdk['src/worker.tsx'],
      },
      'cloudflare',
    );
    expect(p.read('vite.config.mts')).toContain(
      "cloudflare({ viteEnvironment: { name: 'worker' } }), redwood(), hypdriv()",
    );
    const wrangler = parseJsonc(p.read('wrangler.jsonc')) as unknown as WranglerShape;
    expect(wrangler).toMatchObject({
      main: 'src/worker.tsx',
      assets: { binding: 'ASSETS', run_worker_first: ['/*', '!/assets/*'] },
    });
    expect(wrangler.durable_objects.bindings).toHaveLength(3);
  });

  it('RedwoodSDK: only Workers are a target, and a Worker it cannot edit gets the snippet', async () => {
    const vercel = await init(rwsdk, 'vercel');
    expect(vercel.out.notes.join('\n')).toContain('Cloudflare Worker and has no Node or Vercel target');
    expect(existsSync(join(vercel.p.dir, 'vercel.json'))).toBe(false);
    expect(vercel.p.read('src/worker.tsx')).toContain('withHypDriv(defineApp(');

    const unreadable = await init(
      { ...rwsdk, 'src/worker.tsx': 'export default makeApp();\n' },
      'cloudflare',
    );
    const item = unreadable.out.plan.find((i) => i.path === 'src/worker.tsx');
    expect(item?.action).toBe('manual');
    expect(item?.hint).toContain('hypdrivMiddleware()');
    expect(unreadable.p.read('src/worker.tsx')).toBe('export default makeApp();\n');
  });
});

describe('wrapRwsdkApp', () => {
  const imports = "import { defineApp } from 'rwsdk/worker';\n";

  it('wraps a default export and puts the middleware first in a multi-line array, matching its indent', () => {
    const r = wrapRwsdkApp(
      `${imports}\nexport default defineApp([\n    render(Document, [route('/', Home)]),\n  ]);\n`,
    );
    expect(r.changed).toBe(true);
    expect(r.middleware).toBe(true);
    expect(r.content).toContain(
      "export default withHypDriv(defineApp([\n    hypdrivMiddleware(),\n    render(Document, [route('/', Home)]),\n  ]));",
    );
    expect(
      r.content.startsWith(
        `${imports}import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';`,
      ),
    ).toBe(true);
    expect(r.reason).toBe('wrap defineApp() in withHypDriv() and add hypdrivMiddleware() as the first route');
  });

  it('handles an inline array and a const that is exported as default', () => {
    const inline = wrapRwsdkApp(`${imports}export default defineApp([route('/', Home)]);\n`);
    expect(inline.content).toContain(
      "export default withHypDriv(defineApp([hypdrivMiddleware(), route('/', Home)]));",
    );
    const named = wrapRwsdkApp(`${imports}const app = defineApp([route('/', Home)]);\nexport default app;\n`);
    expect(named.content).toContain(
      "const app = withHypDriv(defineApp([hypdrivMiddleware(), route('/', Home)]));",
    );
    expect(named.middleware).toBe(true);
  });

  it('adds only what is missing', () => {
    const wrapped = `import { withHypDriv } from '@hypdriv/rwsdk/worker';\n${imports}export default withHypDriv(defineApp([route('/', Home)]));\n`;
    const r = wrapRwsdkApp(wrapped);
    expect(r.content).toContain("withHypDriv(defineApp([hypdrivMiddleware(), route('/', Home)]))");
    // The name that is not imported yet joins the existing import from the module (still one import of it).
    expect(r.content.match(/@hypdriv\/rwsdk\/worker/g)).toHaveLength(1);
    expect(r.content).toContain("import { withHypDriv, hypdrivMiddleware } from '@hypdriv/rwsdk/worker';");
    expect(r.reason).toBe('add hypdrivMiddleware() as the first route');

    const complete = `import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';\nexport default withHypDriv(defineApp([hypdrivMiddleware()]));\n`;
    expect(wrapRwsdkApp(complete)).toMatchObject({ changed: false, content: complete, middleware: true });
  });

  it('imports each name on its own: an existing import of the module does not stand in for the others', () => {
    // Only the middleware is imported: withHypDriv() would be a ReferenceError at run time.
    const middlewareOnly = wrapRwsdkApp(
      `import { hypdrivMiddleware } from '@hypdriv/rwsdk/worker';\n${imports}export default defineApp([hypdrivMiddleware(), route('/', Home)]);\n`,
    );
    expect(middlewareOnly.content).toContain(
      "import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';",
    );
    expect(middlewareOnly.content).toContain('export default withHypDriv(defineApp([hypdrivMiddleware()');
    expect(middlewareOnly.reason).toBe('wrap defineApp() in withHypDriv()');

    // A multi-line import keeps its layout; a type-only import binds nothing, so a value import is added.
    const multiline = wrapRwsdkApp(
      `import {\n  withHypDriv,\n} from '@hypdriv/rwsdk/worker';\n${imports}export default withHypDriv(defineApp([route('/', Home)]));\n`,
    );
    expect(multiline.content).toContain(
      "import {\n  withHypDriv,\n  hypdrivMiddleware,\n} from '@hypdriv/rwsdk/worker';",
    );
    const typeOnly = wrapRwsdkApp(
      `import type { HypDrivApp } from '@hypdriv/rwsdk/worker';\n${imports}export default defineApp([route('/', Home)]);\n`,
    );
    expect(typeOnly.content).toContain(
      "import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';",
    );
    expect(typeOnly.content).toContain("import type { HypDrivApp } from '@hypdriv/rwsdk/worker';");
  });

  it('accepts the helpers used through a namespace import', () => {
    const source = `import * as hd from '@hypdriv/rwsdk/worker';\n${imports}export default hd.withHypDriv(defineApp([hd.hypdrivMiddleware(), route('/', Home)]));\n`;
    expect(wrapRwsdkApp(source)).toMatchObject({ changed: false, content: source, middleware: true });
  });

  it('wraps routes that are not an array literal but cannot place the middleware', () => {
    const r = wrapRwsdkApp(
      `${imports}import { routes } from './routes';\nexport default defineApp(routes);\n`,
    );
    expect(r.changed).toBe(true);
    expect(r.middleware).toBe(false);
    expect(r.content).toContain('export default withHypDriv(defineApp(routes));');
    expect(r.content).not.toContain('hypdrivMiddleware');
  });

  it('leaves alone a file with no defineApp(), one whose app is not the default export, and broken code', () => {
    expect(wrapRwsdkApp('export default makeApp();\n')).toMatchObject({ changed: false, middleware: false });
    const other = wrapRwsdkApp(
      `${imports}export const app = defineApp([route('/', Home)]);\nexport default {};\n`,
    );
    expect(other).toMatchObject({ changed: false });
    expect(other.reason).toContain('not the default export');
    expect(wrapRwsdkApp(`${imports}export default defineApp([route('/', Home)`).reason).toContain(
      'could not parse',
    );
  });

  it('ignores defineApp in strings and comments of other calls', () => {
    const r = wrapRwsdkApp(`${imports}// defineApp(old)\nexport default defineApp([route('/', Home)]);\n`);
    expect(r.content).toContain('// defineApp(old)');
    expect(r.content).toContain('withHypDriv(defineApp([hypdrivMiddleware(), route');
  });
});

describe('hypdriv init (SolidStart)', () => {
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

  const solid = {
    'package.json': JSON.stringify({
      name: 'sol',
      dependencies: { '@solidjs/start': '^2.1.0', 'solid-js': '^1.9.18' },
      devDependencies: { vite: '^8.3.5' },
    }),
    ...installed('@solidjs/start', '2.1.0'),
  };
  const solidEntry =
    "import { createHandler, StartServer } from '@solidjs/start/server';\n\nexport default createHandler(() => (\n  <StartServer document={({ assets, children, scripts }) => <html><head>{assets}</head><body>{children}{scripts}</body></html>} />\n));\n";
  const solidConfig =
    "import { solidStart } from '@solidjs/start/config';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [solidStart()],\n});\n";

  it('SolidStart: cloudflare() after solidStart(), hypdrivStart() in the server entry, the Worker shell and wrangler settings', async () => {
    const { p, out } = await init(
      { ...solid, 'vite.config.ts': solidConfig, 'src/entry-server.tsx': solidEntry },
      'cloudflare',
    );
    const vite = p.read('vite.config.ts');
    expect(vite).toContain("import { hypdriv } from '@hypdriv/solid-start/vite';");
    expect(vite).toContain("import { cloudflare } from '@cloudflare/vite-plugin';");
    expect(vite).toMatch(
      /plugins: \[solidStart\(\), cloudflare\(\{ viteEnvironment: \{ name: 'ssr' \} \}\), hypdriv\(\)\]/,
    );
    const entry = p.read('src/entry-server.tsx');
    expect(entry).toContain("import { hypdrivStart } from '@hypdriv/solid-start';");
    expect(entry).toMatch(/\), hypdrivStart\(\)\);/);
    const worker = p.read('src/worker.ts');
    expect(worker).toContain('createSolidStartWorker');
    expect(worker).toContain("entry: () => import('./entry-server')");
    expect(worker).toContain('durable-objects');
    const wrangler = parseJsonc(p.read('wrangler.jsonc')) as unknown as WranglerShape;
    expect(wrangler).toMatchObject({
      main: 'src/worker.ts',
      assets: { binding: 'ASSETS', run_worker_first: ['/*', '!/_build/assets/*'] },
    });
    expect(wrangler.durable_objects.bindings).toHaveLength(3);
    const pkg = JSON.parse(p.read('package.json')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies['@hypdriv/solid-start']).toBeDefined();
    expect(pkg.dependencies['@hypdriv/cloudflare']).toBeDefined();
    expect(pkg.scripts['hypdriv:audit']).toContain('8787');
    expect(out.notes.join('\n')).toContain('cloudflare_module');
  });

  it('SolidStart: Vercel and Node register nitro() with an explicit preset right before hypdriv()', async () => {
    const files = { ...solid, 'vite.config.ts': solidConfig, 'src/entry-server.tsx': solidEntry };
    const vercel = await init(files, 'vercel');
    expect(vercel.p.read('vite.config.ts')).toMatch(
      /plugins: \[solidStart\(\), nitro\(\{ preset: 'vercel' \}\), hypdriv\(\)\]/,
    );
    expect(vercel.p.read('vite.config.ts')).toContain("import { nitro } from 'nitro/vite';");
    expect(existsSync(join(vercel.p.dir, 'src', 'worker.ts'))).toBe(false);
    expect(existsSync(join(vercel.p.dir, 'wrangler.jsonc'))).toBe(false);
    expect(vercel.out.notes.join('\n')).toContain('prerender');

    const node = await init(files, 'node');
    expect(node.p.read('vite.config.ts')).toContain("nitro({ preset: 'node-server' }), hypdriv()");
    expect(JSON.parse(node.p.read('package.json')).scripts.start).toBe('node .output/server/index.mjs');
    expect(node.out.notes.join('\n')).toContain('.output/server/index.mjs');
  });

  it('SolidStart: a registration that is already there is not repeated', async () => {
    const { p, out } = await init(
      {
        ...solid,
        'vite.config.ts':
          "import { hypdriv } from '@hypdriv/solid-start/vite';\nimport { solidStart } from '@solidjs/start/config';\nimport { nitro } from 'nitro/vite';\n\nexport default defineConfig({ plugins: [solidStart(), nitro({ preset: 'node-server' }), hypdriv()] });\n",
        'src/entry-server.tsx': solidEntry.replace('));', '), hypdrivStart());'),
      },
      'node',
    );
    expect(p.read('vite.config.ts').match(/hypdriv\(\)/g)).toHaveLength(1);
    expect(p.read('vite.config.ts').match(/nitro\(/g)).toHaveLength(1);
    expect(out.plan.find((i) => i.path === 'vite.config.ts')?.action).toBe('skip');
    expect(out.plan.find((i) => i.path === 'src/entry-server.tsx')?.action).toBe('skip');
  });

  it('SolidStart: a project without vite.config or server entry gets both', async () => {
    const node = await init(solid, 'node');
    expect(node.p.read('vite.config.ts')).toContain(
      "plugins: [solidStart(), nitro({ preset: 'node-server' }), hypdriv()]",
    );
    expect(node.p.read('vite.config.ts')).toContain('prerender');
    expect(node.p.read('src/entry-server.tsx')).toContain('hypdrivStart()');
    const cf = await init(solid, 'cloudflare');
    expect(cf.p.read('vite.config.ts')).toContain("cloudflare({ viteEnvironment: { name: 'ssr' } })");
    expect(cf.p.read('vite.config.ts')).not.toContain('nitro');
  });

  it('SolidStart: render options the app already has, and SolidStart 1, are left for the developer', async () => {
    const options = await init(
      {
        ...solid,
        'vite.config.ts': solidConfig,
        'src/entry-server.tsx': solidEntry.replace('));', '), { mode: "async" });'),
      },
      'node',
    );
    expect(options.out.plan.find((i) => i.path === 'src/entry-server.tsx')?.action).toBe('manual');
    expect(options.p.read('src/entry-server.tsx')).not.toContain('hypdrivStart');

    const v1 = await init(
      {
        'package.json': JSON.stringify({ name: 'old', dependencies: { '@solidjs/start': '^1.3.2' } }),
        ...installed('@solidjs/start', '1.3.2'),
        'app.config.ts':
          "import { defineConfig } from '@solidjs/start/config';\nexport default defineConfig({});\n",
      },
      'node',
    );
    expect(v1.out.plan.find((i) => i.path === 'app.config.ts')?.action).toBe('manual');
    expect(existsSync(join(v1.p.dir, 'vite.config.ts'))).toBe(false);
  });

  it('SolidStart: an existing wrangler config keeps its name and gets the missing settings', async () => {
    const { p } = await init(
      {
        ...solid,
        'vite.config.ts': solidConfig,
        'src/entry-server.tsx': solidEntry,
        'wrangler.jsonc':
          '{\n  "name": "my-solid",\n  "main": "src/worker.ts",\n  "compatibility_date": "2026-10-01",\n  "compatibility_flags": ["nodejs_compat"]\n}\n',
      },
      'cloudflare',
    );
    const wrangler = parseJsonc(p.read('wrangler.jsonc')) as unknown as WranglerShape;
    expect(wrangler.name).toBe('my-solid');
    expect(wrangler.durable_objects.bindings).toHaveLength(3);
    expect(wrangler.assets).toMatchObject({ run_worker_first: ['/*', '!/_build/assets/*'] });
  });
});

describe('addHypdrivStart', () => {
  it('adds the render options as the second argument of createHandler() and the import', () => {
    const source =
      "import { createHandler, StartServer } from '@solidjs/start/server';\n\nexport default createHandler(() => (\n  <StartServer document={() => <html />} />\n));\n";
    const r = addHypdrivStart(source);
    expect(r.changed).toBe(true);
    expect(r.content).toContain("import { hypdrivStart } from '@hypdriv/solid-start';");
    expect(r.content).toContain('<StartServer document={() => <html />} />\n), hypdrivStart());');
    expect(addHypdrivStart(r.content)).toMatchObject({
      changed: false,
      reason: expect.stringContaining('already'),
    });
  });

  it('puts it after a function with a trailing comma and leaves existing options alone', () => {
    expect(addHypdrivStart('export default createHandler(() => <App />,\n);').content).toContain(
      'createHandler(() => <App />, hypdrivStart(),\n)',
    );
    const withOptions = addHypdrivStart("export default createHandler(() => <App />, { mode: 'async' });");
    expect(withOptions.changed).toBe(false);
    expect(withOptions.reason).toContain('render options');
  });

  it('reports a file it cannot place it in', () => {
    expect(addHypdrivStart('export default 1;').reason).toContain('no createHandler()');
    expect(addHypdrivStart('export default createHandler();').reason).toContain('no render function');
    expect(addHypdrivStart('export default createHandler(() => (').reason).toContain('could not parse');
  });
});

describe('hypdriv init (Qwik)', () => {
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
