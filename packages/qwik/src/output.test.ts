import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverEntries } from './adapters/common';
import {
  findCloudflareEntry,
  hasDefaultExport,
  workerSource,
  writeCloudflareWorker,
} from './output/cloudflare';
import {
  copyStaticOutput,
  FUNCTION_NAME,
  findVercelEntry,
  vercelRoutes,
  writeFunctionConfig,
  writeOutputConfig,
} from './output/vercel';

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-qwik-out-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('serverEntries', () => {
  it('returns what the adapter collected', () => {
    expect(serverEntries(['entry.node.js'], '/nowhere')).toEqual(['entry.node.js']);
  });

  it('lists the top-level modules of the server output when the adapter collected none', () => {
    const root = tree({
      'entry.cloudflare.js': '',
      'run-ssg.js': '',
      'package.json': '{}',
      'build/q-a.js': '',
    });
    expect(serverEntries([], root)).toEqual(['entry.cloudflare.js']);
    expect(serverEntries([], join(root, 'missing'))).toEqual([]);
  });
});

describe('Cloudflare output', () => {
  it('finds the Cloudflare entry module', () => {
    expect(findCloudflareEntry(['entry.cloudflare.js', 'other.js'])).toBe('entry.cloudflare.js');
    expect(findCloudflareEntry(['entry.cloudflare.mjs'])).toBe('entry.cloudflare.mjs');
    expect(findCloudflareEntry(['entry.vercel.js', 'entry.cloudflare-pages.js'])).toBeUndefined();
  });

  it('recognises a default export in built code', () => {
    expect(hasDefaultExport('export default createQwikRouter({})')).toBe(true);
    expect(hasDefaultExport('export{Lr as HypDrivLimiter,Hr as default}')).toBe(true);
    expect(hasDefaultExport('export const a = 1;')).toBe(false);
  });

  it('re-exports the entry, Durable Objects included', () => {
    const source = workerSource('../server/entry.cloudflare.js');
    expect(source).toContain('export * from "../server/entry.cloudflare.js";');
    expect(source).toContain('export { default } from "../server/entry.cloudflare.js";');
  });

  it('writes _worker.js next to the assets and keeps it out of the upload', () => {
    const root = tree({ 'server/entry.cloudflare.js': 'export default {};', 'dist/index.html': '' });
    const errors: string[] = [];
    const file = writeCloudflareWorker({
      clientDir: join(root, 'dist'),
      serverDir: join(root, 'server'),
      entryFile: 'entry.cloudflare.js',
      error: (message) => errors.push(message),
    });
    expect(file).toBe(join(root, 'dist', '_worker.js'));
    expect(readFileSync(file, 'utf8')).toContain('"../server/entry.cloudflare.js"');
    expect(readFileSync(join(root, 'dist', '.assetsignore'), 'utf8')).toContain('_worker.js');
    expect(errors).toEqual([]);
  });

  it('reports an entry that does not export the Worker', () => {
    const root = tree({ 'server/entry.cloudflare.js': 'export const a = 1;', 'dist/index.html': '' });
    const errors: string[] = [];
    writeCloudflareWorker({
      clientDir: join(root, 'dist'),
      serverDir: join(root, 'server'),
      entryFile: 'entry.cloudflare.js',
      error: (message) => errors.push(message),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('default export');
  });
});

describe('Vercel output', () => {
  it('finds the Vercel entry module', () => {
    expect(findVercelEntry(['entry.vercel.js'])).toBe('entry.vercel.js');
    expect(findVercelEntry(['entry.vercel.mjs', 'x.js'])).toBe('entry.vercel.mjs');
    expect(findVercelEntry(['entry.vercel-edge.js'])).toBeUndefined();
  });

  it('routes mutating requests to the function, files and documents to the CDN, the rest to the function', () => {
    expect(vercelRoutes({ basePathname: '/', noTrailingSlash: false })).toEqual([
      { src: '^/.*$', methods: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], dest: `/${FUNCTION_NAME}` },
      { handle: 'filesystem' },
      { src: '^/(.+)/$', dest: '/$1/index.html', check: true },
      { src: '^/.*$', dest: `/${FUNCTION_NAME}` },
    ]);
  });

  it('serves documents without a trailing slash when the app has none', () => {
    const routes = vercelRoutes({ basePathname: '/', noTrailingSlash: true });
    expect(routes[2]).toEqual({ src: '^/(.*[^/])$', dest: '/$1/index.html', check: true });
  });

  it('scopes the routes to the base pathname', () => {
    const routes = vercelRoutes({ basePathname: '/docs/', noTrailingSlash: false });
    expect(routes[0]?.src).toBe('^/docs/.*$');
    expect(routes[2]).toEqual({ src: '^/docs/(.+)/$', dest: '/docs/$1/index.html', check: true });
    expect(routes[3]?.src).toBe('^/docs/.*$');
  });

  it('writes the function configuration of a Node.js Web handler', () => {
    const root = tree({ 'fn/.keep': '' });
    writeFunctionConfig({ functionDir: join(root, 'fn'), handler: 'entry.vercel.js', runtime: 'nodejs22.x' });
    expect(JSON.parse(readFileSync(join(root, 'fn', '.vc-config.json'), 'utf8'))).toEqual({
      runtime: 'nodejs22.x',
      handler: 'entry.vercel.js',
      launcherType: 'Nodejs',
      useWebApi: true,
      supportsResponseStreaming: true,
      shouldAddHelpers: false,
    });
    expect(JSON.parse(readFileSync(join(root, 'fn', 'package.json'), 'utf8'))).toEqual({ type: 'module' });
  });

  it('copies the client build to the static output without platform files', () => {
    const root = tree({
      'dist/index.html': 'home',
      'dist/about/index.html': 'about',
      'dist/build/q-a.js': 'js',
      'dist/_headers': 'x',
      'dist/_worker.js': 'x',
      'dist/.assetsignore': 'x',
      'dist/.hypdriv/manifest.json': '{}',
      'out/static/stale.html': 'stale',
    });
    const target = copyStaticOutput({
      clientDir: join(root, 'dist'),
      outputDir: join(root, 'out'),
      basePathname: '/',
    });
    expect(target).toBe(join(root, 'out', 'static'));
    expect(existsSync(join(target, 'index.html'))).toBe(true);
    expect(existsSync(join(target, 'about', 'index.html'))).toBe(true);
    expect(existsSync(join(target, 'build', 'q-a.js'))).toBe(true);
    for (const gone of ['_headers', '_worker.js', '.assetsignore', '.hypdriv', 'stale.html'])
      expect(existsSync(join(target, gone))).toBe(false);
  });

  it('copies under the base pathname', () => {
    const root = tree({ 'dist/index.html': 'home' });
    const target = copyStaticOutput({
      clientDir: join(root, 'dist'),
      outputDir: join(root, 'out'),
      basePathname: '/docs/',
    });
    expect(target).toBe(join(root, 'out', 'static', 'docs'));
    expect(existsSync(join(target, 'index.html'))).toBe(true);
  });

  it('writes config.json with the Qwik routes', () => {
    const root = tree({ 'out/.keep': '' });
    const file = writeOutputConfig({
      outputDir: join(root, 'out'),
      basePathname: '/',
      noTrailingSlash: false,
    });
    const config = JSON.parse(readFileSync(file, 'utf8')) as { version: number; routes: unknown[] };
    expect(config.version).toBe(3);
    expect(config.routes).toHaveLength(4);
  });
});
