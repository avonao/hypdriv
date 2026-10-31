import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyManifest } from '@hypdriv/core';
import { manifestModuleCode } from '@hypdriv/vite';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactRouterBuildResult } from './build';
import { detectTarget, hasCloudflarePlugin, hypdriv, serverEntryCode } from './plugin';
import { hypdrivPreset } from './preset';
import { PRERENDER_HEADER, VIRTUAL_REACT_ROUTER, VIRTUAL_SERVER_ENTRY } from './shared';
import { registry, rootState } from './state';

// biome-ignore lint/complexity/noBannedTypes: plugin hooks are called directly in these tests
type Hook = Function;
const call = (plugin: Plugin, hook: keyof Plugin, ...args: unknown[]) =>
  (plugin[hook] as Hook).call({ environment: { config: { consumer: 'server' } } }, ...args);

afterEach(() => {
  registry().roots.clear();
  registry().presetInstalled = false;
  delete process.env.IS_RR_BUILD_REQUEST;
});

describe('target detection', () => {
  it('prefers the explicit target, then HYPDRIV_TARGET, Vercel, the Cloudflare plugin, Node', () => {
    const cf = [[{ name: 'vite-plugin-cloudflare:config' }]];
    expect(detectTarget('node', cf, { HYPDRIV_TARGET: 'vercel' })).toBe('node');
    expect(detectTarget(undefined, cf, { HYPDRIV_TARGET: 'vercel' })).toBe('vercel');
    expect(detectTarget(undefined, [], { VERCEL: '1' })).toBe('vercel');
    expect(detectTarget(undefined, cf, {})).toBe('cloudflare');
    expect(detectTarget(undefined, [false, null, { name: 'react-router' }], {})).toBe('node');
    expect(hasCloudflarePlugin([[[{ name: 'vite-plugin-cloudflare' }]]])).toBe(true);
  });
});

describe('hypdriv() Vite plugin', () => {
  const root = '/project/app';

  function build(target: 'node' | 'vercel' | 'cloudflare') {
    const [host, plugin] = hypdriv({ target, config: {} });
    call(plugin!, 'config', { root }, { command: 'build', mode: 'production' });
    call(plugin!, 'configResolved', { root, command: 'build', plugins: [] });
    return { host: host!, plugin: plugin! };
  }

  it('makes HypDriv’s server entry the SSR entry of Node and Vercel builds', () => {
    for (const target of ['node', 'vercel'] as const) {
      const { plugin } = build(target);
      const ssr = {
        build: { rollupOptions: { input: 'virtual:react-router/server-build', output: { a: 1 } } },
      };
      call(plugin, 'configEnvironment', 'ssr', ssr, { command: 'build' });
      expect(ssr.build.rollupOptions).toEqual({ input: VIRTUAL_SERVER_ENTRY, output: { a: 1 } });
      const bundle = { build: { rolldownOptions: { input: 'virtual:react-router/server-build' } } };
      call(plugin, 'configEnvironment', 'ssrBundle_nodejs_x', bundle, { command: 'build' });
      expect(bundle.build.rolldownOptions.input).toBe(VIRTUAL_SERVER_ENTRY);
      const custom = { build: { rollupOptions: { input: './server/app.ts' } } };
      call(plugin, 'configEnvironment', 'ssr', custom, { command: 'build' });
      expect(custom.build.rollupOptions.input).toBe('./server/app.ts');
      const client = { build: { rollupOptions: { input: 'virtual:react-router/server-build' } } };
      call(plugin, 'configEnvironment', 'client', client, { command: 'build' });
      expect(client.build.rollupOptions.input).toBe('virtual:react-router/server-build');
    }
    const { plugin } = build('cloudflare');
    const ssr = { build: { rollupOptions: { input: 'virtual:react-router/server-build' } } };
    call(plugin, 'configEnvironment', 'ssr', ssr, { command: 'build' });
    expect(ssr.build.rollupOptions.input).toBe('virtual:react-router/server-build');
    expect(rootState(root).target).toBe('cloudflare');
  });

  it('serves the build token to server code, an empty one outside builds', () => {
    const { plugin } = build('node');
    const token = rootState(root).token!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const resolved = call(plugin, 'resolveId', VIRTUAL_REACT_ROUTER) as string;
    expect(call(plugin, 'load', resolved)).toBe(`export const prerenderToken = ${JSON.stringify(token)};\n`);
    expect(call(plugin, 'load', call(plugin, 'resolveId', VIRTUAL_SERVER_ENTRY))).toBe(serverEntryCode());
    // The same process's preview server (React Router's prerendering) loads a new plugin instance.
    const [, preview] = hypdriv({ target: 'node' });
    call(preview!, 'config', { root }, { command: 'serve', mode: 'production', isPreview: true });
    call(preview!, 'configResolved', { root, command: 'serve', plugins: [] });
    expect(call(preview!, 'load', resolved)).toBe('export const prerenderToken = "";\n');
    expect(rootState(root).token).toBe(token);
  });

  it('marks React Router’s prerender requests on the build-time preview server', () => {
    build('node');
    const token = rootState(root).token!;
    const [, preview] = hypdriv({ target: 'node' });
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const server = {
      config: { root },
      middlewares: { use: (fn: (typeof middlewares)[number]) => middlewares.push(fn) },
    };
    // Outside React Router's build requests nothing is installed.
    call(preview!, 'configurePreviewServer', server);
    expect(middlewares).toHaveLength(0);
    process.env.IS_RR_BUILD_REQUEST = 'yes';
    call(preview!, 'configurePreviewServer', server);
    expect(middlewares).toHaveLength(1);
    const prerender = {
      headers: { 'x-react-router-prerender': 'yes', [PRERENDER_HEADER]: 'spoofed' } as Record<string, string>,
      rawHeaders: ['X-React-Router-Prerender', 'yes', 'X-HypDriv-Prerender', 'spoofed'],
    };
    let nexts = 0;
    middlewares[0]!(prerender, {}, () => nexts++);
    expect(prerender.headers[PRERENDER_HEADER]).toBe(token);
    expect(prerender.rawHeaders).toEqual(['X-React-Router-Prerender', 'yes', PRERENDER_HEADER, token]);
    const other = {
      headers: { [PRERENDER_HEADER]: 'spoofed' } as Record<string, string>,
      rawHeaders: [PRERENDER_HEADER, 'spoofed'],
    };
    middlewares[0]!(other, {}, () => nexts++);
    expect(other.headers[PRERENDER_HEADER]).toBeUndefined();
    expect(other.rawHeaders).toEqual([]);
    expect(nexts).toBe(2);
  });

  it('records that a server environment bundled the runtime manifest', async () => {
    const { host } = build('node');
    const id = call(host, 'resolveId', 'virtual:hypdriv/manifest') as string;
    const code = (await call(host, 'load', id)) as string;
    expect(code).toContain('runtime-manifest');
    expect(rootState(root).manifestBundled).toBe(true);
  });

  it('warns when React Router builds without the preset', () => {
    const warnings: string[] = [];
    const resolved = (plugins: Array<{ name: string }>) => ({
      root,
      command: 'build',
      plugins,
      logger: { warn: (m: string) => warnings.push(m) },
    });
    const [, plugin] = hypdriv({ target: 'node' });
    call(plugin!, 'config', { root }, { command: 'build', mode: 'production' });
    call(plugin!, 'configResolved', resolved([{ name: 'react-router' }]));
    expect(warnings.join()).toContain('hypdrivPreset() is missing');
    warnings.length = 0;
    registry().presetInstalled = true;
    call(plugin!, 'configResolved', resolved([{ name: 'react-router' }]));
    expect(warnings).toEqual([]);
  });

  it('filters the ineffective-dynamic-import notice of its own virtual modules', () => {
    const { plugin } = build('node');
    expect(
      call(plugin, 'onLog', 'warn', {
        code: 'INEFFECTIVE_DYNAMIC_IMPORT',
        message: '\0virtual:hypdriv/config is …',
      }),
    ).toBe(false);
    expect(
      call(plugin, 'onLog', 'warn', { code: 'INEFFECTIVE_DYNAMIC_IMPORT', message: 'src/a.ts' }),
    ).toBeUndefined();
  });

  it('generates a server entry that keeps React Router’s exports', () => {
    const code = serverEntryCode();
    expect(code).toContain("export * from 'virtual:react-router/server-build';");
    expect(code).toContain('export const hypdriv = createServerEntry(');
    expect(code).toContain('export default function handler(request)');
  });
});

describe('hypdrivPreset()', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('records the resolved React Router config and finalises the build in buildEnd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-rr-preset-'));
    made.push(root);
    mkdirSync(join(root, 'build/client'), { recursive: true });
    mkdirSync(join(root, 'build/server'), { recursive: true });
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app/root.tsx'), 'export default function App() {}');
    writeFileSync(join(root, 'build/client/index.html'), '<!doctype html><script>1</script>');
    writeFileSync(join(root, 'build/server/index.js'), manifestModuleCode(emptyManifest()));
    const routes = { root: { id: 'root', path: '', file: 'root.tsx' } };
    const reactRouterConfig = {
      appDirectory: join(root, 'app'),
      basename: '/',
      buildDirectory: join(root, 'build'),
      routes,
      ssr: true,
      serverBuildFile: 'index.js',
    };
    let finalized: ReactRouterBuildResult | null = null;
    const preset = hypdrivPreset({
      config: { site: { name: 'preset' } },
      onFinalized: (result) => {
        finalized = result;
      },
    });
    expect(preset.name).toBe('hypdriv');
    await preset.reactRouterConfigResolved?.({ reactRouterConfig } as never);
    expect(registry().resolved?.routes).toBe(routes);
    const presetConfig = (await preset.reactRouterConfig?.({ reactRouterUserConfig: {} })) as {
      buildEnd: (args: unknown) => Promise<void>;
    };
    const warnings: string[] = [];
    await presetConfig.buildEnd({
      buildManifest: { routes },
      reactRouterConfig,
      viteConfig: {
        root,
        base: '/',
        build: { assetsDir: 'assets' },
        environments: {
          client: { build: { outDir: join(root, 'build/client') } },
          ssr: { build: { outDir: join(root, 'build/server') } },
        },
        plugins: [],
        logger: { info: () => undefined, warn: (m: string) => warnings.push(m), error: () => undefined },
      },
    });
    expect(finalized).not.toBeNull();
    const result = finalized as unknown as ReactRouterBuildResult;
    expect(result.target).toBe('node');
    expect(result.manifest.routes.map((r) => r.pathname)).toEqual(['/']);
    expect(result.patched).toHaveLength(1);
    expect(readFileSync(join(root, 'build/server/index.js'), 'utf8')).toContain(result.manifest.fingerprint);
    // Without the Vite plugin the preset still finalises, and says what is missing.
    expect(warnings.join('\n')).toContain('Vite plugin is not installed');
  });
});
