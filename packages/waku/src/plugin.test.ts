import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  hasServerEntry,
  hypdriv,
  isManagedWorkerMain,
  mergeRoutes,
  VIRTUAL_DURABLE_OBJECTS,
  VIRTUAL_WORKER_MAIN,
  wakuVersion,
} from './plugin';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
const created: string[] = [];

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-waku-plugin-'));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

describe('route options', () => {
  const discovered = [
    { kind: 'page' as const, pathname: '/', sourcePage: 'src/pages/index.tsx' },
    { kind: 'page' as const, pathname: '/docs', sourcePage: 'src/pages/docs.tsx' },
  ];

  it('keeps the discovered routes without an option', () => {
    expect(mergeRoutes(discovered, undefined)).toBe(discovered);
  });

  it('adds listed routes and lets a listed route replace the discovered one', () => {
    const merged = mergeRoutes(discovered, [
      { kind: 'page', pathname: '/docs', prerendered: true },
      { kind: 'endpoint', pathname: '/feed' },
    ]);
    expect(merged.map((r) => `${r.kind}:${r.pathname}`)).toEqual(['page:/', 'page:/docs', 'endpoint:/feed']);
    expect(merged.find((r) => r.pathname === '/docs')?.prerendered).toBe(true);
  });

  it('lets a function decide the final list', () => {
    expect(mergeRoutes(discovered, (found) => found.slice(0, 1))).toEqual(discovered.slice(0, 1));
  });
});

describe('Waku version', () => {
  it('reads the installed Waku version from the project', () => {
    expect(wakuVersion(packageDir)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('the Worker main of managed mode', () => {
  const root = project();
  const src = join(root, 'src');

  it('recognises wrangler `main` spellings of the missing server entry', () => {
    expect(isManagedWorkerMain('./src/waku.server', root, src)).toBe(true);
    expect(isManagedWorkerMain('src/waku.server', root, src)).toBe(true);
    expect(isManagedWorkerMain('./src/waku.server.tsx', root, src)).toBe(true);
    expect(isManagedWorkerMain(join(src, 'waku.server'), root, src)).toBe(true);
    expect(isManagedWorkerMain('./src/waku.server?v=1', root, src)).toBe(true);
  });

  it("never matches Waku's own root-relative lookup, other files or other directories", () => {
    // Waku resolves `/src/waku.server` itself to find a project file; matching it would loop.
    expect(isManagedWorkerMain('/src/waku.server', root, src)).toBe(false);
    expect(isManagedWorkerMain('./src/waku.client', root, src)).toBe(false);
    expect(isManagedWorkerMain('./other/waku.server', root, src)).toBe(false);
    expect(isManagedWorkerMain('\0virtual:vite-rsc-waku/server-entry', root, src)).toBe(false);
  });

  it('leaves the entry to a project that has its own', () => {
    for (const extension of ['tsx', 'ts', 'js']) {
      const own = project({ [`src/waku.server.${extension}`]: 'export default {};\n' });
      expect(hasServerEntry(join(own, 'src'))).toBe(true);
      expect(isManagedWorkerMain('./src/waku.server', own, join(own, 'src'))).toBe(false);
    }
    expect(hasServerEntry(src)).toBe(false);
  });

  it('honours a custom srcDir', () => {
    const custom = project();
    const dir = join(custom, 'app');
    expect(isManagedWorkerMain('./app/waku.server', custom, dir)).toBe(true);
    expect(isManagedWorkerMain('./src/waku.server', custom, dir)).toBe(false);
  });
});

type Hook = (...args: never[]) => unknown;

function entryPlugin(options: Parameters<typeof hypdriv>[0] = {}) {
  const plugins = hypdriv(options);
  const entry = plugins.find((p) => p.name === 'hypdriv:waku-entry') as Plugin & Record<string, Hook>;
  return { plugins, entry };
}

const resolved = (root: string, plugins: string[] = []) =>
  ({ root, plugins: plugins.map((name) => ({ name })) }) as never;

const WAKU_ENTRY =
  '/app/node_modules/.pnpm/waku@1.0.0/node_modules/waku/dist/lib/vite-entries/entry.server.js';

describe('Hypdriv plugins', () => {
  it('registers the host, entry and build plugins', () => {
    const { plugins } = entryPlugin();
    expect(plugins.map((p) => p.name)).toEqual(['hypdriv:waku', 'hypdriv:waku-entry', 'hypdriv:waku-build']);
    const build = plugins[2] as Plugin;
    expect(build.apply).toBe('build');
    expect(build.enforce).toBe('post');
    expect((build.buildApp as { order: string }).order).toBe('post');
  });

  it('bundles the adapters into the server environments only', () => {
    const { entry } = entryPlugin();
    const configEnvironment = entry.configEnvironment as unknown as (
      name: string,
      environment: { consumer: string },
    ) => unknown;
    expect(configEnvironment('client', { consumer: 'client' })).toEqual({});
    expect(configEnvironment('rsc', { consumer: 'server' })).toEqual({
      resolve: { noExternal: ['@hypdriv/waku'] },
    });
  });

  it('exports the Durable Object classes from Waku’s server entry on Cloudflare, once', () => {
    const { entry } = entryPlugin({ target: 'cloudflare' });
    (entry.configResolved as unknown as (c: unknown) => void)(resolved('/app', ['vite-plugin-cloudflare']));
    const transform = entry.transform as unknown as (
      this: unknown,
      code: string,
      id: string,
    ) => { code: string } | null;
    const rsc = { environment: { name: 'rsc' } };
    const out = transform.call(rsc, 'export default {};', WAKU_ENTRY);
    expect(out?.code).toContain(`export * from ${JSON.stringify(VIRTUAL_DURABLE_OBJECTS)}`);
    expect(transform.call(rsc, out?.code ?? '', WAKU_ENTRY)).toBeNull();
    // Only Waku's entry, only in the rsc environment.
    expect(transform.call(rsc, 'export default {};', '/app/src/other.ts')).toBeNull();
    expect(transform.call({ environment: { name: 'ssr' } }, 'export default {};', WAKU_ENTRY)).toBeNull();
    expect(transform.call(rsc, 'export default {};', `${WAKU_ENTRY}?v=1`)?.code).toContain('durable-objects');
  });

  it('leaves the server entry alone off Cloudflare and when Durable Objects are disabled', () => {
    const node = entryPlugin({ target: 'node' }).entry;
    (node.configResolved as unknown as (c: unknown) => void)(resolved('/app'));
    const transform = (plugin: typeof node) =>
      plugin.transform as unknown as (this: unknown, code: string, id: string) => unknown;
    expect(transform(node).call({ environment: { name: 'rsc' } }, 'x', WAKU_ENTRY)).toBeNull();

    const off = entryPlugin({ target: 'cloudflare', durableObjects: false }).entry;
    (off.configResolved as unknown as (c: unknown) => void)(resolved('/app', ['vite-plugin-cloudflare']));
    expect(transform(off).call({ environment: { name: 'rsc' } }, 'x', WAKU_ENTRY)).toBeNull();
  });

  it('serves the virtual Durable Object and Worker main modules', () => {
    const root = project();
    const { entry } = entryPlugin({ target: 'cloudflare' });
    (entry.configResolved as unknown as (c: unknown) => void)(resolved(root, ['vite-plugin-cloudflare']));
    const resolveId = entry.resolveId as unknown as (id: string) => string | null;
    const load = entry.load as unknown as (id: string) => string | null;

    expect(resolveId(VIRTUAL_DURABLE_OBJECTS)).toBe(`\0${VIRTUAL_DURABLE_OBJECTS}`);
    expect(load(`\0${VIRTUAL_DURABLE_OBJECTS}`)).toMatch(/^export \* from ".*durable-objects/);
    expect(resolveId(VIRTUAL_WORKER_MAIN)).toBe(`\0${VIRTUAL_WORKER_MAIN}`);
    // wrangler's `main` without a server file of the project is the managed entry plus the Durable Objects.
    expect(resolveId('./src/waku.server')).toBe(`\0${VIRTUAL_WORKER_MAIN}`);
    const main = load(`\0${VIRTUAL_WORKER_MAIN}`) ?? '';
    expect(main).toContain("from 'virtual:vite-rsc-waku/server-entry'");
    expect(main).toContain(`export * from ${JSON.stringify(VIRTUAL_DURABLE_OBJECTS)}`);
    expect(main).toContain('export default server');
    expect(resolveId('/src/waku.server')).toBeNull();
    expect(resolveId('./src/pages/index.tsx')).toBeNull();
    expect(load('/src/pages/index.tsx')).toBeNull();
  });

  it('does not take over wrangler’s main when the project has a server file or targets another platform', () => {
    const own = project({ 'src/waku.server.tsx': 'export default {};\n' });
    const cloudflare = entryPlugin({ target: 'cloudflare' }).entry;
    (cloudflare.configResolved as unknown as (c: unknown) => void)(resolved(own, ['vite-plugin-cloudflare']));
    expect((cloudflare.resolveId as unknown as (id: string) => unknown)('./src/waku.server')).toBeNull();

    const node = entryPlugin({ target: 'node' }).entry;
    (node.configResolved as unknown as (c: unknown) => void)(resolved(project()));
    expect((node.resolveId as unknown as (id: string) => unknown)('./src/waku.server')).toBeNull();
  });
});
