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
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// SolidStart 2 declares Node 24; Nitro 3 and the Vite 8 build run on the 22.12+ line this package supports.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && minor >= 12);

type Target = 'node' | 'vercel' | 'cloudflare';

const PRESETS: Record<Target, string> = {
  node: 'node-server',
  vercel: 'vercel',
  cloudflare: 'cloudflare_module',
};

/** The fixture app of the real builds: two prerendered pages, a dynamic page that reads the request, an API route. */
function fixture(root: string, target: Target): void {
  const source = (file: string) => JSON.stringify(join(packageDir, 'src', file));
  write(root, {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'vite.config.ts': [
      "import { solidStart } from '@solidjs/start/config';",
      "import { nitro } from 'nitro/vite';",
      "import { defineConfig } from 'vite';",
      `import { hypdriv } from ${source('vite')};`,
      'export default defineConfig({',
      '  plugins: [',
      '    solidStart(),',
      `    nitro({ preset: '${PRESETS[target]}' }),`,
      '    hypdriv({',
      "      config: { site: { name: 'fixture' }, security: { bots: { definitelyAutomated: 'block' } } },",
      '    }),',
      '  ],',
      "  nitro: { prerender: { routes: ['/', '/about'] } },",
      '});',
      '',
    ].join('\n'),
    'src/global.d.ts': '/// <reference types="@solidjs/start/env" />\n',
    'src/entry-client.tsx':
      "import { mount, StartClient } from '@solidjs/start/client';\nmount(() => <StartClient />, document.getElementById('app')!);\n",
    'src/entry-server.tsx': [
      `import { hypdrivStart } from ${source('start')};`,
      "import { createHandler, StartServer } from '@solidjs/start/server';",
      'export default createHandler(',
      '  () => (',
      '    <StartServer',
      '      document={({ assets, children, scripts }) => (',
      '        <html lang="en">',
      '          <head>',
      '            <meta charset="utf-8" />',
      '            <title>Fixture</title>',
      '            {assets}',
      '          </head>',
      '          <body>',
      '            <div id="app">{children}</div>',
      '            {scripts}',
      '          </body>',
      '        </html>',
      '      )}',
      '    />',
      '  ),',
      '  hypdrivStart(),',
      ');',
      '',
    ].join('\n'),
    'src/app.tsx': [
      "import { Router } from '@solidjs/router';",
      "import { FileRoutes } from '@solidjs/start/router';",
      "import { Suspense } from 'solid-js';",
      'export default function App() {',
      '  return (',
      '    <Router root={(props) => <Suspense>{props.children}</Suspense>}>',
      '      <FileRoutes />',
      '    </Router>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'src/request-facts.ts': [
      `import { hyp } from ${source('server')};`,
      "import { query } from '@solidjs/router';",
      'export const getFacts = query(async () => {',
      "  'use server';",
      '  const c = hyp();',
      '  return { requestId: c?.requestId ?? null, nonce: c?.nonce ?? null, runner: c?.runner ?? null };',
      "}, 'facts');",
      '',
    ].join('\n'),
    'src/routes/index.tsx': 'export default function Home() { return <main><h1>Home</h1></main>; }\n',
    'src/routes/about.tsx': 'export default function About() { return <main><p>About</p></main>; }\n',
    'src/routes/request.tsx': [
      "import { createAsync } from '@solidjs/router';",
      "import { Show } from 'solid-js';",
      "import { getFacts } from '../request-facts';",
      'export default function RequestPage() {',
      '  const facts = createAsync(() => getFacts(), { deferStream: true });',
      '  return (',
      '    <main>',
      '      <Show when={facts()}>',
      '        {(f) => <p id="facts">{f().requestId}|{f().runner}|{f().nonce}</p>}',
      '      </Show>',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'src/routes/posts/[slug].tsx':
      "import { useParams } from '@solidjs/router';\nexport default function Post() { const p = useParams(); return <article>{p.slug}</article>; }\n",
    'src/routes/api/ping.ts': [
      `import { hyp } from ${source('server')};`,
      'export function GET() { return Response.json({ runner: hyp()?.runner ?? null }); }',
      '',
    ].join('\n'),
    'public/robots.txt': 'User-agent: *\n',
  });
}

/** Runs `vite build` of the fixture and returns the environment it ran with. */
async function viteBuild(
  root: string,
  extra: Record<string, string> = {},
): Promise<Record<string, string | undefined>> {
  const viteCli = join(packageDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const env = { ...process.env, ...extra } as Record<string, string | undefined>;
  delete env.VITEST;
  delete env.NODE_ENV;
  // The Vercel preset is selected by the fixture's config; keep the host's own Vercel variables out of the build.
  if (!extra.VERCEL) delete env.VERCEL;
  await run(process.execPath, [viteCli, 'build'], { cwd: root, env, maxBuffer: 32 * 1024 * 1024 });
  return env;
}

const inlineScripts = (html: string) =>
  [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);

describe.skipIf(!supported)('a real SolidStart build', () => {
  it('writes the Vercel Build Output: clean-URL overrides, static header rules, Routing Middleware and the final manifest', async () => {
    mkdirSync(buildsDir, { recursive: true });
    const root = mkdtempSync(join(buildsDir, 'vercel-'));
    created.push(root);
    fixture(root, 'vercel');
    const env = await viteBuild(root, { VERCEL: '1' });

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    expect(manifest.framework).toMatchObject({ name: 'solid-start', adapter: 'vercel', bundler: 'vite' });
    expect(manifest.csp['page:/']?.scriptHashes?.length).toBeGreaterThan(0);
    expect(manifest.csp['page:/about']?.scriptHashes?.length).toBeGreaterThan(0);
    expect(manifest.csp['page:/request']).toBeUndefined();

    const output = join(root, '.vercel', 'output');
    expect(existsSync(join(output, 'static', 'index.html'))).toBe(true);
    expect(existsSync(join(output, 'static', 'about', 'index.html'))).toBe(true);
    const config = JSON.parse(readFileSync(join(output, 'config.json'), 'utf8')) as {
      routes: Array<{
        src?: string;
        headers?: Record<string, string>;
        middlewarePath?: string;
        dest?: string;
        handle?: string;
      }>;
      overrides?: Record<string, { path?: string; contentType?: string }>;
    };
    // The CDN answers `/about` from `about/index.html`.
    expect(config.overrides?.['about/index.html']).toEqual({
      path: 'about',
      contentType: 'text/html; charset=utf-8',
    });
    // The prerendered documents carry their hash policy and the security headers; hashed assets are immutable.
    const about = config.routes.find((r) => r.src === '^/about$');
    expect(about?.headers?.['x-hypdriv-csp']).toBe('hash');
    expect(about?.headers?.['content-security-policy']).toContain('sha256-');
    expect(
      config.routes.some(
        (r) => r.src === '^/_build/assets/(?:.*)$' && /immutable/.test(r.headers?.['cache-control'] ?? ''),
      ),
    ).toBe(true);
    // The request stages run for the CDN-served documents through Hypdriv's Routing Middleware, before the filesystem.
    const middleware = config.routes.findIndex((r) => r.middlewarePath !== undefined);
    expect(middleware).toBeGreaterThan(-1);
    expect(existsSync(join(output, 'functions', '_hypdriv'))).toBe(true);
    expect(middleware).toBeLessThan(config.routes.findIndex((r) => r.handle === 'filesystem'));
    // Everything else reaches Nitro's function, which embeds the final manifest and so runs the pipeline.
    expect(config.routes.at(-1)?.dest).toBe('/__server');
    const fn = join(output, 'functions', '__server.func');
    const embedding = readdirSync(fn, { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.m?js$/.test(file) && readFileSync(join(fn, file), 'utf8').includes(manifest.buildId),
    );
    expect(embedding.length).toBeGreaterThan(0);

    // Call the function in process, the way Vercel's launcher does: every response runs through the pipeline.
    const previous = { ...process.env };
    Object.assign(process.env, { ...env, VERCEL: '1' });
    try {
      const mod = (await import(pathToFileURL(join(fn, 'index.mjs')).href)) as {
        default: { fetch(request: Request, context?: unknown): Promise<Response> };
      };
      const call = (path: string, headers: Record<string, string> = browser) =>
        mod.default.fetch(new Request(`https://shop.example${path}`, { headers }), { waitUntil() {} });

      const health = (await (await call('/_hypdriv/health')).json()) as { runner: string; target: string };
      expect(health).toMatchObject({ runner: 'host', target: 'vercel' });

      const request = await call('/request');
      expect(request.status).toBe(200);
      const html = await request.text();
      const nonce = /'nonce-([^']+)'/.exec(request.headers.get('content-security-policy') ?? '')?.[1];
      expect(nonce).toBeTruthy();
      // Solid rendered the facts of this request: id, runner and the nonce the policy allows.
      expect(html).toMatch(new RegExp(`id="facts"[^]*${request.headers.get('x-request-id')}[^]*host`));
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);

      expect(await (await call('/api/ping')).json()).toEqual({ runner: 'host' });
      expect((await call('/.vite/manifest.json')).status).toBe(404);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  }, 240_000);

  it('builds a Cloudflare Worker with Nitro: static headers for the assets and the final manifest in the Worker bundle', async () => {
    mkdirSync(buildsDir, { recursive: true });
    const root = mkdtempSync(join(buildsDir, 'cloudflare-'));
    created.push(root);
    fixture(root, 'cloudflare');
    await viteBuild(root);

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    expect(manifest.framework).toMatchObject({
      name: 'solid-start',
      adapter: 'cloudflare-module',
      bundler: 'vite',
    });
    expect(manifest.csp['page:/about']?.scriptHashes?.length).toBeGreaterThan(0);

    // Workers Static Assets answer the prerendered pages (and `/about/`, where they redirect `/about`) with the
    // headers of `_headers`: the hash policy of each page, the security headers, immutable hashed assets.
    const publicDir = join(root, '.output', 'public');
    const headers = readFileSync(join(publicDir, '_headers'), 'utf8');
    for (const path of ['/', '/about', '/about/']) {
      const rule = new RegExp(`^${path}\\n((?:  .+\\n?)+)`, 'm').exec(headers)?.[1] ?? '';
      expect(rule, path).toContain('x-hypdriv-csp: hash');
      expect(rule, path).toContain("script-src 'self' 'sha256-");
    }
    expect(headers).toMatch(
      /\/_build\/assets\/\*\n(?: {2}.+\n)*? {2}cache-control: public, max-age=31536000, immutable/,
    );
    // Build metadata stays out of the upload.
    const ignored = readFileSync(join(publicDir, '.assetsignore'), 'utf8').split('\n');
    expect(ignored).toContain('.vite');
    expect(ignored).toContain('.hypdriv');

    // The Worker bundle Nitro wrote embeds the final manifest, so its pipeline plugin has the CSP hashes.
    const server = join(root, '.output', 'server');
    const embedding = readdirSync(server, { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.m?js$/.test(file) && readFileSync(join(server, file), 'utf8').includes(manifest.buildId),
    );
    expect(embedding.length).toBeGreaterThan(0);
    expect(existsSync(join(server, 'wrangler.json'))).toBe(true);
  }, 240_000);

  it('prerenders with Nitro, patches the manifest into the Node server and serves through the pipeline', async () => {
    mkdirSync(buildsDir, { recursive: true });
    const root = mkdtempSync(join(buildsDir, 'node-'));
    created.push(root);
    fixture(root, 'node');
    const env = await viteBuild(root);

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    const byId = Object.fromEntries(manifest.routes.map((r) => [r.id, r]));
    expect(manifest.framework).toMatchObject({
      name: 'solid-start',
      adapter: 'node-server',
      bundler: 'vite',
    });
    expect(manifest.framework?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(byId['page:/']?.classification).toBe('static');
    expect(byId['page:/about']?.classification).toBe('static');
    expect(byId['page:/request']?.classification).toBe('dynamic');
    expect(byId['page:/posts/[slug]']?.classification).toBe('dynamic');
    expect(byId['endpoint:/api/ping']?.classification).toBe('route');
    // `"use server"` functions are served at /_server.
    expect(byId['endpoint:/_server/[[...path]]']).toBeDefined();
    expect(manifest.csp['page:/request']).toBeUndefined();
    // Each page lists the client chunks of its route (SolidStart's `?pick=default` entries in the Vite manifest).
    expect(byId['page:/about']?.assets.js.length).toBeGreaterThan(0);

    // Nitro prerendered the pages without Hypdriv's pipeline: no nonce is baked in, and the hashes in the manifest
    // cover every inline script of the file.
    const publicDir = join(root, '.output', 'public');
    const home = readFileSync(join(publicDir, 'index.html'), 'utf8');
    expect(home).not.toContain('nonce=');
    const inline = inlineScripts(home).map(
      (code) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`,
    );
    expect(inline.length).toBeGreaterThan(0);
    for (const hash of inline) expect(manifest.csp['page:/']?.scriptHashes).toContain(hash);
    expect(existsSync(join(publicDir, 'about', 'index.html'))).toBe(true);

    // The final manifest is embedded in the server output Nitro's entry loads.
    const server = join(root, '.output', 'server');
    const embedding = readdirSync(server, { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.m?js$/.test(file) && readFileSync(join(server, file), 'utf8').includes(manifest.buildId),
    );
    expect(embedding.length).toBeGreaterThan(0);

    // Serve the build in its own process: every response runs through the pipeline.
    const port = await freePort();
    const child = spawn(process.execPath, [join(server, 'index.mjs')], {
      cwd: root,
      env: {
        ...env,
        PORT: String(port),
        NITRO_PORT: String(port),
        HOST: '127.0.0.1',
        NITRO_HOST: '127.0.0.1',
      },
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
    expect(health.framework).toContain('SolidStart');

    // A prerendered page: Nitro's file, byte for byte, under the hash policy of the manifest.
    const homeResponse = await fetch(`${base}/`, { headers: browser });
    expect(homeResponse.status).toBe(200);
    expect(homeResponse.headers.get('x-hypdriv-csp')).toBe('hash');
    expect(homeResponse.headers.get('x-frame-options')).toBe('DENY');
    expect(homeResponse.headers.get('content-security-policy')).toContain(inline[0] as string);
    expect(await homeResponse.text()).toBe(home);
    expect((await fetch(`${base}/about`, { headers: browser })).status).toBe(200);
    expect((await fetch(`${base}/robots.txt`, { headers: browser })).status).toBe(200);

    // A rendered page: a nonce policy, and the nonce on every script Solid streams (hydration, resources, entry).
    const dynamic = await fetch(`${base}/request`, { headers: browser });
    const html = await dynamic.text();
    const nonce = /'nonce-([^']+)'/.exec(dynamic.headers.get('content-security-policy') ?? '')?.[1];
    expect(dynamic.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(nonce).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="facts"[^]*${dynamic.headers.get('x-request-id')}[^]*host`));
    // Solid renders the nonce into the page itself (server function result), not only into the tags.
    expect(html.split(nonce as string).length).toBeGreaterThan(3);
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(1);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    // Another request gets another nonce.
    const second = await fetch(`${base}/posts/hello`, { headers: browser });
    expect(/'nonce-([^']+)'/.exec(second.headers.get('content-security-policy') ?? '')?.[1]).not.toBe(nonce);
    expect(await second.text()).toContain('hello');

    const ping = await fetch(`${base}/api/ping`, { headers: browser });
    expect(await ping.json()).toEqual({ runner: 'host' });
    expect(ping.headers.get('x-request-id')).toBeTruthy();

    // Hashed assets keep the immutable cache header and the security headers Nitro's route rules carry.
    const asset = /(?:href|src)="(\/_build\/assets\/[^"]+\.(?:js|css))"/.exec(home);
    expect(asset?.[1]).toBeTruthy();
    const assetResponse = await fetch(`${base}${asset?.[1]}`, { headers: { ...browser, accept: '*/*' } });
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('cache-control')).toMatch(/immutable/);
    expect(assetResponse.headers.get('x-content-type-options')).toBe('nosniff');

    // Build metadata Nitro copies into the public directory is not served.
    expect((await fetch(`${base}/.vite/manifest.json`, { headers: browser })).status).toBe(404);
    // (`fetch` adds accept-language / sec-fetch-* headers a real curl never sends, which lowers the verdict.)
    expect(await statusOf(`${base}/request`, { 'user-agent': 'curl/8.9.1', accept: 'text/html' })).toBe(403);
    expect(await statusOf(`${base}/about`, { 'user-agent': 'curl/8.9.1', accept: 'text/html' })).toBe(403);
  }, 240_000);
});
