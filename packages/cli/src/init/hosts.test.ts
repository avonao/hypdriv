import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, installed, memoryIO, tempProject } from '../__tests__/helpers';
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
      out: JSON.parse(io.out) as { plan: Array<{ path: string; action: string }>; notes: string[] },
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
});
