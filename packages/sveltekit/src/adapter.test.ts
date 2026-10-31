import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HypManifest } from '@hypdriv/core';
import { developmentManifest, manifestModuleCode } from '@hypdriv/vite';
import type { Adapter, AdapterViteConfig, Builder } from '@sveltejs/kit';
import type { Plugin } from 'vite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hypdriv, kitCsp, targetOf, VIRTUAL_SVELTEKIT } from './adapter';
import { embeddedManifests } from './build';

const tmp = mkdtempSync(join(tmpdir(), 'hypdriv-sk-adapter-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const kitConfig = (root: string, csp: Record<string, unknown> = {}) => ({
  appDir: '_app',
  outDir: join(root, '.svelte-kit'),
  paths: { base: '', assets: '', relative: true },
  files: { routes: 'src/routes' },
  version: { name: 'build-42' },
  csp: {
    mode: 'auto',
    directives: { 'script-src': undefined, ...csp },
    reportOnly: { 'script-src': undefined },
  },
});

const HTML = `<!doctype html><html><head>
<meta http-equiv="content-security-policy" content="script-src 'self' 'sha256-FROMKITMETA='">
<link href="./_app/immutable/entry/start.A.js" rel="modulepreload">
</head><body><div>home</div>
<script>{ __sveltekit_x = { base: new URL(".", location).pathname.slice(0, -1) }; import("./_app/immutable/entry/start.A.js"); }</script>
</body></html>`;

/** A SvelteKit build output (server, client, prerendered) in `root`, as `vite build` leaves it before adapting. */
function fixtureBuild(root: string): Builder {
  const out = join(root, '.svelte-kit', 'output');
  write(
    join(out, 'server', 'manifest-full.js'),
    `export const manifest = { client: {start:"_app/immutable/entry/start.A.js",app:"_app/immutable/entry/app.B.js",imports:["_app/immutable/entry/start.A.js","_app/immutable/entry/app.B.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
routes: [
  { id: "/", pattern: /^\\/$/, params: [], page: { layouts: [0,], errors: [1,], leaf: 2 }, endpoint: null },
  { id: "/ssr", pattern: /^\\/ssr\\/?$/, params: [], page: { layouts: [0,], errors: [1,], leaf: 3 }, endpoint: null },
  { id: "/api/hello", pattern: /^\\/api\\/hello\\/?$/, params: [], page: null, endpoint: null }
] };`,
  );
  for (const n of [0, 2, 3])
    write(
      join(out, 'server', 'nodes', `${n}.js`),
      `export const imports = ["_app/immutable/nodes/${n}.js"];\n`,
    );
  const routes = [
    { id: '/', page: '' },
    { id: '/ssr', page: '' },
    { id: '/api/hello', page: null },
  ].map(({ id }) => ({
    id,
    pattern: new RegExp(id === '/' ? '^\\/$' : `^${id.replace(/\//g, '\\/')}\\/?$`),
  }));
  // The server build embeds the development manifest; the adapter wrapper patches the final one in.
  write(
    join(out, 'server', 'entries', 'hooks.server.js'),
    `const manifest = ${manifestModuleCode(
      developmentManifest({ name: 'sveltekit', version: '3.1.1' }, [{ pathname: '/', kind: 'page' }]),
    )
      .replace('const manifest = ', '')
      .replace('export default manifest;', '')}\nexport { manifest };\n`,
  );
  write(join(out, 'client', '_app', 'immutable', 'entry', 'start.A.js'), 'export const start = 1;');
  write(join(out, 'client', '_app', 'immutable', 'entry', 'app.B.js'), 'export const app = 1;');
  write(join(out, 'client', 'robots.txt'), 'User-agent: *');
  write(join(out, 'prerendered', 'pages', 'index.html'), HTML);
  const logs: string[] = [];
  const log = Object.assign((m: string) => logs.push(m), {
    info: (m: string) => logs.push(`info ${m}`),
    minor: (m: string) => logs.push(`minor ${m}`),
    warn: (m: string) => logs.push(`warn ${m}`),
    error: (m: string) => logs.push(`error ${m}`),
    success: (m: string) => logs.push(`success ${m}`),
  });
  return {
    log,
    logs,
    config: kitConfig(root, { 'script-src': ['self', 'https://js.example.com'] }),
    routes: [
      {
        ...routes[0]!,
        prerender: true,
        page: { methods: ['GET'] },
        api: { methods: [] },
        config: {},
        methods: ['GET'],
        segments: [],
      },
      {
        ...routes[1]!,
        prerender: false,
        page: { methods: ['GET'] },
        api: { methods: [] },
        config: {},
        methods: ['GET'],
        segments: [],
      },
      {
        ...routes[2]!,
        prerender: false,
        page: { methods: [] },
        api: { methods: ['GET'] },
        config: {},
        methods: ['GET'],
        segments: [],
      },
    ],
    prerendered: {
      pages: new Map([['/', { file: 'index.html' }]]),
      assets: new Map(),
      redirects: new Map(),
      paths: ['/'],
    },
    getClientDirectory: () => join(out, 'client'),
    getServerDirectory: () => join(out, 'server'),
    getBuildDirectory: (name: string) => join(root, '.svelte-kit', name),
    getAppPath: () => '_app',
  } as unknown as Builder & { logs: string[] };
}

/** The adapter's Vite settings as SvelteKit resolves them. */
function viteOf(adapter: Adapter, kit: ReturnType<typeof kitConfig>): AdapterViteConfig {
  if (typeof adapter.vite !== 'function') throw new Error('expected the function form');
  return adapter.vite({ config: kit as never });
}

function pluginsOf(vite: AdapterViteConfig): { pre: Plugin[]; post?: Plugin[] } {
  return vite.plugins as { pre: Plugin[]; post?: Plugin[] };
}

/** Runs the plugins' `configResolved` the way Vite does before `adapt`. */
function resolvePlugins(adapter: Adapter, root: string, kit: ReturnType<typeof kitConfig>): Plugin[] {
  const plugins = pluginsOf(viteOf(adapter, kit)).pre;
  for (const p of plugins)
    (p.configResolved as ((c: unknown) => void) | undefined)?.call({}, { root, command: 'build' });
  return plugins;
}

describe('targetOf / kitCsp', () => {
  it('maps adapters to platforms', () => {
    expect(targetOf('@sveltejs/adapter-cloudflare')).toBe('cloudflare');
    expect(targetOf('@sveltejs/adapter-vercel')).toBe('vercel');
    expect(targetOf('@sveltejs/adapter-node')).toBe('node');
    expect(targetOf('@sveltejs/adapter-auto', { VERCEL: '1' })).toBe('vercel');
    expect(targetOf('@sveltejs/adapter-auto', { CF_PAGES: '1' })).toBe('cloudflare');
    expect(targetOf('@sveltejs/adapter-auto', {})).toBeNull();
    expect(targetOf('svelte-adapter-bun')).toBeNull();
  });

  it("keeps the directives SvelteKit's csp option sets", () => {
    expect(kitCsp(kitConfig('/x'))).toBeNull();
    expect(kitCsp(kitConfig('/x', { 'script-src': ['self'], 'img-src': undefined }))).toEqual({
      mode: 'auto',
      directives: { 'script-src': ['self'] },
    });
    expect(kitCsp(null)).toBeNull();
  });
});

describe('hypdriv(adapter)', () => {
  it("contributes HypDriv's plugins before the adapter's and keeps the adapter's Vite settings", () => {
    const getRequest = vi.fn();
    const own: Plugin = { name: 'adapter-own' };
    const post: Plugin = { name: 'adapter-post' };
    const plain = hypdriv({ name: 'x', adapt: () => undefined, vite: { getRequest, plugins: [own] } });
    const viaFn = viteOf(plain, kitConfig('/x'));
    expect(viaFn.getRequest).toBe(getRequest);
    expect(pluginsOf(viaFn).pre.map((p) => p.name)).toEqual([
      'hypdriv:sveltekit',
      'hypdriv:sveltekit-env',
      'adapter-own',
    ]);
    const nested = hypdriv({
      name: 'y',
      adapt: () => undefined,
      vite: () => ({ plugins: { pre: [own], post: [post] } }),
    });
    expect(pluginsOf(viteOf(nested, kitConfig('/x'))).post).toEqual([post]);
    const none = hypdriv({ name: 'z', adapt: () => undefined });
    expect(typeof none.vite).toBe('function');
  });

  it("serves SvelteKit's csp option as virtual:hypdriv/sveltekit", async () => {
    const adapter = hypdriv({ name: 'z', adapt: () => undefined });
    const plugins = resolvePlugins(adapter, tmp, kitConfig(tmp, { 'script-src': ['self'] }));
    const env = plugins.find((p) => p.name === 'hypdriv:sveltekit-env')!;
    const id = (env.resolveId as (id: string) => string | null)(VIRTUAL_SVELTEKIT);
    expect(id).toBe(`\0${VIRTUAL_SVELTEKIT}`);
    expect((env.load as (id: string) => string | null)(id!)).toBe(
      'export const kit = {"csp":{"mode":"auto","directives":{"script-src":["self"]}}};\n',
    );
  });

  it('refuses to adapt when its plugins did not run', async () => {
    const adapter = hypdriv({ name: 'z', adapt: () => undefined });
    await expect(adapter.adapt(fixtureBuild(join(tmp, 'no-plugins')))).rejects.toThrow(/plugins did not run/);
  });

  it('finalises the manifest before the adapter runs and patches every server output (adapter-node)', async () => {
    const root = join(tmp, 'node-app');
    const builder = fixtureBuild(root) as Builder & { logs: string[] };
    let seenAtAdapt: HypManifest | null = null;
    const inner: Adapter = {
      name: '@sveltejs/adapter-node',
      adapt(b) {
        // The server output the adapter copies already carries the final manifest.
        const code = readFileSync(join(b.getServerDirectory(), 'entries', 'hooks.server.js'), 'utf8');
        seenAtAdapt = JSON.parse(
          readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8'),
        ) as HypManifest;
        expect(code).toContain(seenAtAdapt.generatedAt);
        cpSync(b.getServerDirectory(), join(root, 'build', 'server'), { recursive: true });
        writeFileSync(join(root, 'build', 'handler.js'), "export * from './server/handler.js';\n");
      },
    };
    const adapter = hypdriv(inner, {
      config: { site: { name: 'fixture' }, performance: { earlyHints: true } },
    });
    resolvePlugins(adapter, root, builder.config as never);
    await adapter.adapt(builder);
    expect(seenAtAdapt).not.toBeNull();

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    expect(manifest.framework).toMatchObject({ name: 'sveltekit', adapter: 'node', bundler: 'vite' });
    expect(manifest.buildId).toBe('build-42');
    expect(manifest.routes.map((r) => [r.id, r.classification])).toEqual([
      ['page:/', 'static'],
      ['page:/ssr', 'dynamic'],
      ['endpoint:/api/hello', 'route'],
    ]);
    // Hashes of the page's inline script and of SvelteKit's own <meta> policy.
    expect(manifest.csp['page:/']!.scriptHashes).toContain("'sha256-FROMKITMETA='");
    expect(manifest.csp['page:/']!.scriptHashes.length).toBe(2);
    // Early Hints use root-relative URLs although SvelteKit wrote relative ones.
    expect(manifest.earlyHints['page:/']).toContain(
      '</_app/immutable/entry/start.A.js>; rel=modulepreload',
    );
    expect(manifest.earlyHints['page:/ssr']?.join(',')).toContain('/_app/immutable/nodes/3.js');
    expect(existsSync(join(root, '.hypdriv', 'report.md'))).toBe(true);

    const { current, stale } = embeddedManifests(
      [join(root, 'build'), join(root, '.svelte-kit', 'output')],
      manifest,
    );
    expect(current.map((f) => f.slice(root.length))).toEqual([
      '/build/server/entries/hooks.server.js',
      '/.svelte-kit/output/server/entries/hooks.server.js',
    ]);
    expect(stale).toEqual([]);
    expect(builder.logs.some((l) => l.includes('handle is not in the server build'))).toBe(false);
    expect(builder.logs.some((l) => l.includes('final manifest embedded in 2 server file(s)'))).toBe(true);
  });

  it('warns when the server build has no HypDriv handle', async () => {
    const root = join(tmp, 'no-hook');
    const builder = fixtureBuild(root) as Builder & { logs: string[] };
    rmSync(join(root, '.svelte-kit', 'output', 'server', 'entries'), { recursive: true });
    const adapter = hypdriv({ name: '@sveltejs/adapter-node', adapt: () => undefined }, { config: {} });
    resolvePlugins(adapter, root, builder.config as never);
    await adapter.adapt(builder);
    expect(builder.logs.some((l) => l.includes('handle is not in the server build'))).toBe(true);
  });

  it('fails the build when the manifest reports failures', async () => {
    const root = join(tmp, 'budget');
    const builder = fixtureBuild(root);
    const adapter = hypdriv(
      { name: '@sveltejs/adapter-node', adapt: () => undefined },
      { config: { budgets: { routes: { '/**': { js: 1 } }, failOn: 'error' } } },
    );
    resolvePlugins(adapter, root, builder.config as never);
    await expect(adapter.adapt(builder)).rejects.toThrow(/hypdriv: build failed/);
  });
});
