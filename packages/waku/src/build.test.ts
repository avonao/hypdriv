import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { HypManifest } from '@hypdriv/core';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
const buildsDir = join(packageDir, '.test-builds');
const created: string[] = [];
const children: ChildProcess[] = [];

afterAll(() => {
  for (const child of children) child.kill();
  if (process.env.HYPDRIV_KEEP_TEST_BUILDS) return;
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

/** The status of a GET with exactly these headers (no client defaults added). */
const statusOf = (url: string, headers: Record<string, string>) =>
  new Promise<number>((done, fail) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    });
    request.once('error', fail);
    request.end();
  });

const browser = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html',
  'accept-language': 'en-US',
};

// Waku needs Node 22.15+ (this package's `engines`).
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && minor >= 15);

const page = (body: string) => `export default async function Page() { return ${body}; }\n`;

/** The fixture app of the real builds: two prerendered pages, a dynamic page and an API route. */
function fixture(root: string, target: 'node' | 'vercel'): void {
  const source = (file: string) => JSON.stringify(join(packageDir, 'src', file));
  write(root, {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'waku.config.ts': [
      `import { withHypDriv } from ${source('config')};`,
      'export default withHypDriv(',
      '  {',
      '    vite: {',
      '      resolve: {',
      '        alias: {',
      `          '@hypdriv/waku/adapters/${target}': ${source(`adapters/${target}`)},`,
      `          '@hypdriv/waku/server': ${source('server')},`,
      '        },',
      '      },',
      '    },',
      '  },',
      `  { target: '${target}', config: { site: { name: 'fixture' }, security: { bots: { definitelyAutomated: 'block' } } } },`,
      ');',
      '',
    ].join('\n'),
    'src/pages/_root.tsx':
      'export default async function Root({ children }: { children: React.ReactNode }) { return <html lang="en"><head><title>Fixture</title></head><body>{children}</body></html>; }\n',
    'src/pages/index.tsx': `import { Counter } from '../components/counter';\n${page('<main><h1>Home</h1><Counter /></main>')}export const getConfig = async () => ({ render: 'static' }) as const;\n`,
    'src/pages/about.tsx': `${page('<p>About</p>')}export const getConfig = async () => ({ render: 'static' }) as const;\n`,
    'src/pages/account.tsx': `import { hyp } from '@hypdriv/waku/server';\nexport default async function Account() { const c = hyp(); return <p id="facts">{c?.requestId}|{c?.runner}|{c?.nonce}</p>; }\nexport const getConfig = async () => ({ render: 'dynamic' }) as const;\n`,
    'src/pages/_api/ping.ts': `import { hyp } from '@hypdriv/waku/server';\nexport const GET = async () => Response.json({ runner: hyp()?.runner ?? null });\n`,
    'src/components/counter.tsx':
      "'use client';\nimport { useState } from 'react';\nexport function Counter() { const [n, setN] = useState(0); return <button type=\"button\" onClick={() => setN(n + 1)}>{n}</button>; }\n",
    'public/robots.txt': 'User-agent: *\n',
  });
}

/** Runs `waku build` of the fixture and returns the environment it ran with. */
async function wakuBuild(
  root: string,
  target: 'node' | 'vercel',
): Promise<Record<string, string | undefined>> {
  const wakuCli = join(packageDir, 'node_modules', 'waku', 'dist', 'cli.js');
  const env = { ...process.env, HYPDRIV_TARGET: target } as Record<string, string | undefined>;
  delete env.VITEST;
  delete env.NODE_ENV;
  await run(process.execPath, [wakuCli, 'build'], { cwd: root, env, maxBuffer: 16 * 1024 * 1024 });
  return env;
}

describe.skipIf(!supported)('a real Waku build', () => {
  it('writes the Vercel Build Output: clean-URL overrides, static header rules, Routing Middleware and the final manifest', async () => {
    mkdirSync(buildsDir, { recursive: true });
    const root = mkdtempSync(join(buildsDir, 'vercel-'));
    created.push(root);
    fixture(root, 'vercel');
    await wakuBuild(root, 'vercel');

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    expect(manifest.framework).toMatchObject({ name: 'waku', adapter: 'vercel' });
    expect(manifest.csp['page:/']?.scriptHashes?.length).toBeGreaterThan(0);
    expect(manifest.csp['page:/account']).toBeUndefined();

    const output = join(root, '.vercel', 'output');
    expect(existsSync(join(output, 'static', 'index.html'))).toBe(true);
    expect(existsSync(join(output, 'static', 'about', 'index.html'))).toBe(true);
    const config = JSON.parse(readFileSync(join(output, 'config.json'), 'utf8')) as {
      routes: Array<{
        src?: string;
        headers?: Record<string, string>;
        middlewarePath?: string;
        dest?: string;
      }>;
      overrides?: Record<string, { path?: string; contentType?: string }>;
    };
    // The CDN answers `/about` from `about/index.html`.
    expect(config.overrides?.['about/index.html']).toEqual({
      path: 'about',
      contentType: 'text/html; charset=utf-8',
    });
    // The prerendered documents carry their hash policy and the security headers; assets are immutable.
    const about = config.routes.find((r) => r.src === '^/about$');
    expect(about?.headers?.['x-hypdriv-csp']).toBe('hash');
    expect(about?.headers?.['content-security-policy']).toContain('sha256-');
    expect(
      config.routes.some(
        (r) => r.src === '^/assets/(?:.*)$' && /immutable/.test(r.headers?.['cache-control'] ?? ''),
      ),
    ).toBe(true);
    // The request stages run for the CDN-served documents through Hypdriv's Routing Middleware, before the filesystem.
    const middleware = config.routes.findIndex((r) => r.middlewarePath !== undefined);
    expect(middleware).toBeGreaterThan(-1);
    expect(existsSync(join(output, 'functions', '_hypdriv'))).toBe(true);
    expect(middleware).toBeLessThan(
      config.routes.findIndex((r) => 'handle' in r && (r as { handle?: string }).handle === 'filesystem'),
    );
    // Everything else reaches Waku's function, which embeds the final manifest and so runs the pipeline.
    expect(config.routes.at(-1)?.dest).toBe('/RSC/');
    const embedding = readdirSync(join(output, 'functions', 'RSC.func'), {
      recursive: true,
      encoding: 'utf8',
    }).filter(
      (file) =>
        /\.m?js$/.test(file) &&
        readFileSync(join(output, 'functions', 'RSC.func', file), 'utf8').includes(manifest.buildId),
    );
    expect(embedding.length).toBeGreaterThan(0);
  }, 180_000);

  it('writes the manifest after static generation, patches it into the Node server and serves through the pipeline', async () => {
    mkdirSync(buildsDir, { recursive: true });
    const root = mkdtempSync(join(buildsDir, 'node-'));
    created.push(root);
    fixture(root, 'node');
    const env = await wakuBuild(root, 'node');

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    const byId = Object.fromEntries(manifest.routes.map((r) => [r.id, r]));
    expect(manifest.framework).toMatchObject({ name: 'waku', adapter: 'node', bundler: 'vite' });
    expect(manifest.framework?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(byId['page:/']?.classification).toBe('static');
    expect(byId['page:/about']?.classification).toBe('static');
    expect(byId['page:/account']?.classification).toBe('dynamic');
    expect(byId['endpoint:/ping']?.classification).toBe('route');
    expect(manifest.csp['page:/account']).toBeUndefined();

    // Waku prerendered the pages without Hypdriv: the hashes in the manifest cover every inline script.
    const home = readFileSync(join(root, 'dist', 'public', 'index.html'), 'utf8');
    expect(home).not.toContain('nonce=');
    const inline = [...home.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`,
    );
    expect(inline.length).toBeGreaterThan(0);
    for (const hash of inline) expect(manifest.csp['page:/']?.scriptHashes).toContain(hash);
    expect(existsSync(join(root, 'dist', 'public', 'about', 'index.html'))).toBe(true);

    // The final manifest is embedded in the server output Waku's Node entry loads.
    const embedding = readdirSync(join(root, 'dist', 'server'), { recursive: true, encoding: 'utf8' }).filter(
      (file) =>
        file.endsWith('.js') &&
        readFileSync(join(root, 'dist', 'server', file), 'utf8').includes(manifest.buildId),
    );
    expect(embedding.length).toBeGreaterThan(0);
    expect(existsSync(join(root, 'dist', 'serve-node.js'))).toBe(true);

    // Serve the build in its own process: every response runs through the pipeline.
    const port = await freePort();
    const serverEnv = { ...env, PORT: String(port), HOST: '127.0.0.1' };
    const child = spawn(process.execPath, [join(root, 'dist', 'serve-node.js')], {
      cwd: root,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const base = `http://127.0.0.1:${port}`;
    const started = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}): ${output}`);
      try {
        if ((await fetch(`${base}/_hypdriv/health`, { headers: browser })).ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() - started > 30_000) throw new Error(`server did not start: ${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }

    const health = (await (await fetch(`${base}/_hypdriv/health`, { headers: browser })).json()) as {
      runner: string;
      framework: string;
      target: string;
    };
    expect(health).toMatchObject({ runner: 'host', target: 'node' });
    expect(health.framework).toContain('Waku');

    const homeResponse = await fetch(`${base}/`, { headers: browser });
    expect(homeResponse.status).toBe(200);
    expect(homeResponse.headers.get('x-hypdriv-csp')).toBe('hash');
    expect(homeResponse.headers.get('x-frame-options')).toBe('DENY');
    expect(await homeResponse.text()).toBe(home);

    expect((await fetch(`${base}/about`, { headers: browser })).status).toBe(200);
    expect((await fetch(`${base}/robots.txt`, { headers: browser })).status).toBe(200);

    const account = await fetch(`${base}/account`, { headers: browser });
    const html = await account.text();
    const nonce = /'nonce-([^']+)'/.exec(account.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(
      `${account.headers.get('x-request-id')}<!-- -->|<!-- -->host<!-- -->|<!-- -->${nonce}`,
    );
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);

    const ping = await fetch(`${base}/ping`, { headers: browser });
    expect(await ping.json()).toEqual({ runner: 'host' });
    expect(ping.headers.get('x-request-id')).toBeTruthy();

    // Waku's immutable assets keep the cache header the pipeline adds, and automation is stopped.
    const asset = /href="(\/assets\/[^"]+\.css)"|src="(\/assets\/[^"]+\.js)"/.exec(home);
    const assetPath = asset?.[1] ?? asset?.[2];
    if (assetPath) {
      const res = await fetch(`${base}${assetPath}`, { headers: { ...browser, accept: '*/*' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toMatch(/immutable/);
    }
    // (`fetch` adds accept-language / sec-fetch-* headers a real curl never sends, which lowers the verdict.)
    expect(await statusOf(`${base}/account`, { 'user-agent': 'curl/8.9.1', accept: 'text/html' })).toBe(403);
    expect(await statusOf(`${base}/about`, { 'user-agent': 'curl/8.9.1', accept: 'text/html' })).toBe(403);
  }, 180_000);
});
