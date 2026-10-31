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
