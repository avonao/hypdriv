import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HypManifest } from '@hypdriv/core';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { createBuilder, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hypdriv, resetStartRegistration, startRegistration, withHypDriv } from './index';
import { packageVersion } from './plugin';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = join(pkg, 'src');

// A real TanStack Start app, built (client, server, prerendering) with the Hypdriv plugin from source. It lives
// below the package's node_modules so the app resolves React and TanStack from there.
const cwd = process.cwd();
let root = '';
let token = '';
// Route options are inline object literals: TanStack's generator reads their keys (component, server…).
const routeFile = (id: string, options: string) =>
  `import { createFileRoute } from '@tanstack/react-router';\nimport { createElement as h } from 'react';\nexport const Route = createFileRoute('${id}')(${options});\n`;
const files: Record<string, string> = {
  'package.json': '{ "name": "hypdriv-tss-build-fixture", "private": true, "type": "module" }',
  // Start's prerender preview loads the config file again: it builds the plugins the test hands it.
  'vite.config.mjs': 'export default globalThis.__hypdrivTssFixtureConfig();\n',
  'src/routes/__root.ts': `import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { createElement as h } from 'react';
export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: 'utf-8' }, { title: 'fixture' }] }),
  component: () => h(Outlet),
  shellComponent: ({ children }) => h('html', null, h('head', null, h(HeadContent)), h('body', null, children, h(Scripts))),
});
`,
  'src/routes/about.ts': routeFile('/about', "{ component: () => h('h1', null, 'about') }"),
  'src/routes/account.ts': routeFile('/account', "{ component: () => h('h1', null, 'account') }"),
  'src/routes/api/ping.ts': routeFile(
    '/api/ping',
    '{ server: { handlers: { GET: () => Response.json({ ok: true }) } } }',
  ),
  'src/router.ts': `import { hypdrivSsr } from '@hypdriv/tanstack-start';
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
export function getRouter() { return createRouter({ routeTree, ssr: hypdrivSsr() }); }
`,
  'src/start.ts': `import { hypdrivRequestMiddleware } from '@hypdriv/tanstack-start';
import { createStart } from '@tanstack/react-start';
const requestMiddleware = hypdrivRequestMiddleware();
export const startInstance = createStart(() => ({ requestMiddleware }));
`,
};

/** Resolves the package's own entries from source: the server build gets the runtime, the client the stand-ins. */
function sourceEntries(): Plugin {
  return {
    name: 'fixture:hypdriv-source',
    enforce: 'pre',
    resolveId(id) {
      const client =
        (this as { environment?: { config?: { consumer?: string } } }).environment?.config?.consumer ===
        'client';
      if (id === '@hypdriv/tanstack-start') return join(src, client ? 'client.ts' : 'index.ts');
      if (id === '@hypdriv/tanstack-start/server')
        return join(src, client ? 'server-client.ts' : 'server.ts');
      return null;
    },
  };
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

beforeAll(async () => {
  const cache = join(pkg, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  root = mkdtempSync(join(cache, 'hypdriv-tss-build-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const conditions = ['source', 'module', 'node', 'development|production'];
  (globalThis as { __hypdrivTssFixtureConfig?: () => unknown }).__hypdrivTssFixtureConfig = () => ({
    root,
    logLevel: 'silent',
    ssr: { noExternal: true, resolve: { conditions, externalConditions: ['source'] } },
    plugins: [
      sourceEntries(),
      tanstackStart(
        withHypDriv({
          prerender: { enabled: true, autoStaticPathsDiscovery: false, crawlLinks: false },
          pages: [{ path: '/about' }],
        }),
      ),
      hypdriv({
        config: { site: { name: 'build-fixture' }, security: { bots: { definitelyAutomated: 'block' } } },
      }),
    ],
  });
  // Start's prerender preview server finds the server bundle relative to the working directory.
  process.chdir(root);
  const builder = await createBuilder({
    root,
    configFile: join(root, 'vite.config.mjs'),
    logLevel: 'silent',
  });
  token = startRegistration()!.token;
  await builder.buildApp();
}, 120_000);

afterAll(() => {
  process.chdir(cwd);
  resetStartRegistration();
  delete (globalThis as { __hypdrivTssFixtureConfig?: unknown }).__hypdrivTssFixtureConfig;
  delete process.env.TSS_PRERENDERING;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('a TanStack Start build with hypdriv()', () => {
  it('writes the manifest with routes, the prerendered page and its CSP hashes', () => {
    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    expect(manifest.framework).toMatchObject({ name: 'tanstack-start', bundler: 'vite', adapter: 'node' });
    expect(manifest.framework?.version).toBe(packageVersion(pkg, '@tanstack/react-start'));
    const routes = Object.fromEntries(manifest.routes.map((r) => [r.id, r.classification]));
    expect(routes).toEqual({
      'page:/about': 'static',
      'page:/account': 'dynamic',
      'endpoint:/api/ping': 'route',
      'endpoint:/_serverFn/[...id]': 'route',
    });
    expect(manifest.csp['page:/about']?.scriptHashes.length).toBeGreaterThan(0);
    const about = manifest.routes.find((r) => r.id === 'page:/about')!;
    expect(about.assets.js.some((a) => a.startsWith('/assets/'))).toBe(true);
  });

  it('prerenders without the pipeline: no request nonce in the static document', () => {
    const html = readFileSync(join(root, 'dist', 'client', 'about.html'), 'utf8');
    expect(html).toContain('<h1>about</h1>');
    expect(html).not.toContain('nonce');
    expect(existsSync(join(root, 'dist', 'client', 'about', 'index.html'))).toBe(false);
  });

  it('patches the final manifest into the server bundle and removes the prerender token', () => {
    const server = walk(join(root, 'dist', 'server')).filter((f) => /\.(?:m?js|map)$/.test(f));
    const code = server.map((f) => readFileSync(f, 'utf8'));
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(code.some((c) => c.includes(token))).toBe(false);
    const embedded = code.find((c) => c.includes('runtime-manifest'))!;
    expect(embedded).toContain('\\"classification\\":\\"static\\"');
    expect(embedded).toContain('sha256-');
  });

  it('keeps the runtime out of the client bundle', () => {
    const client = walk(join(root, 'dist', 'client', 'assets')).map((f) => readFileSync(f, 'utf8'));
    expect(client.some((c) => c.includes('runtime-manifest') || c.includes('build-fixture'))).toBe(false);
  });
});
