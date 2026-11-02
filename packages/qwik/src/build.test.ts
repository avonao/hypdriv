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

// Vite 8 needs Node 20.19+ or 22.12+.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);

/**
 * The fixture app of the real builds: a prerendered home page and About page, a dynamic route with one prerendered
 * path (`/blog/hello/`), a page rendered per request (`/account/`) and an endpoint (`/api/ping`).
 */
function fixture(root: string, target: 'node' | 'vercel'): void {
  const source = (file: string) => JSON.stringify(join(packageDir, 'src', file));
  const alias = (name: string, file: string) => `'@hypdriv/qwik/${name}': ${source(file)},`;
  const adapterConfig = (extra: string) =>
    [
      `import { ${target}Adapter } from ${source(`adapters/${target}`)};`,
      "import { extendConfig } from '@qwik.dev/router/vite';",
      "import baseConfig from '../../vite.config';",
      '',
      'export default extendConfig(baseConfig, () => ({',
      extra,
      `  plugins: [${target}Adapter({ ssg: { include: ['/*'], exclude: ['/api/*', '/account/*'] } })],`,
      '}));',
      '',
    ].join('\n');
  write(root, {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        jsx: 'react-jsx',
        jsxImportSource: '@qwik.dev/core',
        strict: true,
        moduleResolution: 'Bundler',
        skipLibCheck: true,
        noEmit: true,
        isolatedModules: true,
      },
      include: ['src'],
    }),
    'hypdriv.config.mjs': [
      "import { defineConfig } from '@hypdriv/core';",
      'export default defineConfig({',
      "  site: { name: 'fixture' },",
      "  security: { bots: { definitelyAutomated: 'block' } },",
      '});',
      '',
    ].join('\n'),
    'vite.config.ts': [
      `import { hypdriv } from ${source('index')};`,
      "import { qwikVite } from '@qwik.dev/core/optimizer';",
      "import { qwikRouter } from '@qwik.dev/router/vite';",
      "import { defineConfig } from 'vite';",
      '',
      'export default defineConfig({',
      '  resolve: {',
      '    alias: {',
      `      ${alias('middleware/node', 'middleware/node')}`,
      `      ${alias('middleware/vercel', 'middleware/vercel')}`,
      `      ${alias('server', 'server')}`,
      '    },',
      '  },',
      '  plugins: [qwikRouter(), qwikVite(), hypdriv()],',
      '});',
      '',
    ].join('\n'),
    'adapters/node/vite.config.ts': adapterConfig(
      "  build: { ssr: true, rolldownOptions: { input: ['src/entry.node.tsx'] } },",
    ),
    'adapters/vercel/vite.config.ts': adapterConfig(
      [
        '  build: {',
        '    ssr: true,',
        "    rolldownOptions: { input: ['src/entry.vercel.tsx'] },",
        "    outDir: '.vercel/output/functions/_qwik-router.func',",
        '  },',
      ].join('\n'),
    ),
    'src/entry.ssr.tsx': [
      "import { createRenderer } from '@qwik.dev/router';",
      "import Root from './root';",
      '',
      'export default createRenderer((options) => ({ jsx: <Root />, options }));',
      '',
    ].join('\n'),
    'src/entry.node.tsx': [
      "import { createServer } from 'node:http';",
      "import { createQwikRouter } from '@hypdriv/qwik/middleware/node';",
      "import render from './entry.ssr';",
      '',
      'const { listener } = createQwikRouter({ render });',
      "createServer(listener).listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');",
      '',
    ].join('\n'),
    'src/entry.vercel.tsx': [
      "import { createQwikRouter } from '@hypdriv/qwik/middleware/vercel';",
      "import render from './entry.ssr';",
      '',
      'export default createQwikRouter({ render });',
      '',
    ].join('\n'),
    'src/root.tsx': [
      "import { component$ } from '@qwik.dev/core';",
      "import { DocumentHeadTags, RouterOutlet, useQwikRouter } from '@qwik.dev/router';",
      '',
      'export default component$(() => {',
      '  useQwikRouter();',
      '  return (',
      '    <>',
      '      <head>',
      '        <meta charset="utf-8" />',
      '        <DocumentHeadTags />',
      '      </head>',
      '      <body>',
      '        <RouterOutlet />',
      '      </body>',
      '    </>',
      '  );',
      '});',
      '',
    ].join('\n'),
    'src/components/counter.tsx': [
      "import { component$, useSignal } from '@qwik.dev/core';",
      '',
      'export const Counter = component$(() => {',
      '  const count = useSignal(0);',
      '  return (',
      '    <button type="button" onClick$={() => count.value++}>',
      '      Clicked {count.value}',
      '    </button>',
      '  );',
      '});',
      '',
    ].join('\n'),
    'src/routes/index.tsx': [
      "import { component$ } from '@qwik.dev/core';",
      "import { Counter } from '../components/counter';",
      '',
      'export default component$(() => (',
      '  <main>',
      '    <h1>Home</h1>',
      '    <Counter />',
      '  </main>',
      '));',
      '',
    ].join('\n'),
    'src/routes/about/index.tsx': [
      "import { component$ } from '@qwik.dev/core';",
      '',
      'export default component$(() => <p>About</p>);',
      '',
    ].join('\n'),
    'src/routes/blog/[slug]/index.tsx': [
      "import { component$ } from '@qwik.dev/core';",
      "import { type StaticGenerateHandler, useLocation } from '@qwik.dev/router';",
      '',
      'export default component$(() => {',
      '  const { params } = useLocation();',
      '  return <p>Post {params.slug}</p>;',
      '});',
      '',
      "export const onStaticGenerate: StaticGenerateHandler = () => ({ params: [{ slug: 'hello' }] });",
      '',
    ].join('\n'),
    'src/routes/account/index.tsx': [
      "import { component$ } from '@qwik.dev/core';",
      "import { routeLoader$ } from '@qwik.dev/router';",
      "import { hyp } from '@hypdriv/qwik/server';",
      '',
      'export const useFacts = routeLoader$(({ headers }) => {',
      "  headers.set('cache-control', 'no-store');",
      '  const context = hyp();',
      "  return { requestId: context?.requestId ?? 'none', runner: context?.runner ?? 'none', nonce: context?.nonce ?? 'none' };",
      '});',
      '',
      'export default component$(() => {',
      '  const facts = useFacts();',
      '  return (',
      '    <p id="facts" data-request-id={facts.value.requestId} data-runner={facts.value.runner} data-nonce={facts.value.nonce}>',
      '      Account',
      '    </p>',
      '  );',
      '});',
      '',
    ].join('\n'),
    'src/routes/api/ping/index.ts': [
      "import type { RequestHandler } from '@qwik.dev/router';",
      "import { hyp } from '@hypdriv/qwik/server';",
      '',
      'export const onGet: RequestHandler = ({ json }) => json(200, { runner: hyp()?.runner ?? null });',
      '',
    ].join('\n'),
    'public/robots.txt': 'User-agent: *\n',
  });
}

/** Runs the client build and the server build of the fixture and returns the environment they ran with. */
async function qwikBuild(
  root: string,
  target: 'node' | 'vercel',
): Promise<Record<string, string | undefined>> {
  const vite = join(packageDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const env = { ...process.env, HYPDRIV_TARGET: target } as Record<string, string | undefined>;
  delete env.VITEST;
  delete env.NODE_ENV;
  const options = { cwd: root, env, maxBuffer: 32 * 1024 * 1024 };
  await run(process.execPath, [vite, 'build'], options);
  await run(process.execPath, [vite, 'build', '-c', `adapters/${target}/vite.config.ts`], options);
  return env;
}

const sha256 = (script: string) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`;

/** The executable inline scripts of a document (data blocks such as `application/json` are not subject to CSP). */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes]) => !/\bsrc=/.test(attributes ?? ''))
    .filter(([, attributes]) => {
      const type = /\btype="([^"]*)"/.exec(attributes ?? '')?.[1];
      return !type || type === 'module' || /javascript/.test(type);
    })
    .map(([, , code]) => code ?? '');
}

describe.skipIf(!supported)('a real Qwik build', () => {
  it('writes the Vercel Build Output: clean-URL routes, static header rules, Routing Middleware and the final manifest', async () => {
    mkdirSync(buildsDir, { recursive: true });
    const root = mkdtempSync(join(buildsDir, 'vercel-'));
    created.push(root);
    fixture(root, 'vercel');
    const env = await qwikBuild(root, 'vercel');

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    expect(manifest.framework).toMatchObject({ name: 'qwik', adapter: 'vercel', bundler: 'vite' });
    expect(manifest.csp['page:/']?.scriptHashes?.length).toBeGreaterThan(0);
    expect(manifest.csp['page:/blog/hello']?.scriptHashes?.length).toBeGreaterThan(0);
    expect(manifest.csp['page:/account']).toBeUndefined();

    const output = join(root, '.vercel', 'output');
    for (const file of ['index.html', 'about/index.html', 'blog/hello/index.html', 'robots.txt']) {
      expect(existsSync(join(output, 'static', file)), file).toBe(true);
    }
    // Endpoints and pages rendered per request are not files.
    expect(existsSync(join(output, 'static', 'account', 'index.html'))).toBe(false);

    const config = JSON.parse(readFileSync(join(output, 'config.json'), 'utf8')) as {
      version: number;
      routes: Array<{
        src?: string;
        headers?: Record<string, string>;
        methods?: string[];
        middlewarePath?: string;
        dest?: string;
        handle?: string;
      }>;
    };
    expect(config.version).toBe(3);
    // Both spellings of a prerendered page carry its hash policy and the security headers; assets are immutable.
    for (const src of ['^/$', '^/about/$', '^/about$', '^/blog/hello/$']) {
      const route = config.routes.find((r) => r.src === src);
      expect(route?.headers?.['x-hypdriv-csp'], src).toBe('hash');
      expect(route?.headers?.['content-security-policy'], src).toContain('sha256-');
    }
    expect(config.routes.some((r) => r.src === '^/blog/[^/]+/$')).toBe(false);
    expect(config.routes.find((r) => r.src === '^/(?:.*)$')?.headers?.['x-frame-options']).toBe('DENY');
    expect(
      config.routes.some(
        (r) => r.src === '^/build/(?:.*)$' && /immutable/.test(r.headers?.['cache-control'] ?? ''),
      ),
    ).toBe(true);
    // Writes always reach the function; the stages run for CDN-served documents through Routing Middleware, which
    // comes before the filesystem.
    const mutating = config.routes.find((r) => r.methods?.includes('POST'));
    expect(mutating?.dest).toBe('/_qwik-router');
    const middleware = config.routes.findIndex((r) => r.middlewarePath !== undefined);
    expect(middleware).toBeGreaterThan(-1);
    expect(existsSync(join(output, 'functions', '_hypdriv'))).toBe(true);
    const filesystem = config.routes.findIndex((r) => r.handle === 'filesystem');
    expect(middleware).toBeLessThan(filesystem);
    expect(config.routes.at(-1)?.dest).toBe('/_qwik-router');

    // Qwik's function: a Node.js Web handler with streaming, embedding the final manifest.
    const functionDir = join(output, 'functions', '_qwik-router.func');
    const functionConfig = JSON.parse(readFileSync(join(functionDir, '.vc-config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(functionConfig).toMatchObject({
      handler: 'entry.vercel.js',
      launcherType: 'Nodejs',
      useWebApi: true,
      supportsResponseStreaming: true,
    });
    expect(readFileSync(join(functionDir, 'entry.vercel.js'), 'utf8')).toContain(manifest.buildId);

    // Call the function the way Vercel does: one Web Request in, one Response out, through the pipeline.
    write(root, {
      'invoke.mjs': [
        "import { pathToFileURL } from 'node:url';",
        `const { default: handler } = await import(pathToFileURL(${JSON.stringify(join(functionDir, 'entry.vercel.js'))}).href);`,
        `const headers = ${JSON.stringify(browser)};`,
        'const out = {};',
        "for (const path of ['/account/', '/blog/other/', '/api/ping', '/_hypdriv/health', '/missing/']) {",
        '  const response = await handler(new Request(new URL(path, "https://shop.example"), { headers }));',
        '  out[path] = {',
        '    status: response.status,',
        '    csp: response.headers.get("content-security-policy"),',
        '    mode: response.headers.get("x-hypdriv-csp"),',
        '    body: await response.text(),',
        '  };',
        '}',
        // The loaded server keeps a MessagePort open, which would keep the process alive.
        'process.stdout.write(JSON.stringify(out) + "\\n", () => process.exit(0));',
        '',
      ].join('\n'),
    });
    const { stdout } = await run(process.execPath, [join(root, 'invoke.mjs')], {
      cwd: root,
      env: env as NodeJS.ProcessEnv,
      maxBuffer: 16 * 1024 * 1024,
    });
    const called = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<
      string,
      { status: number; csp: string | null; mode: string | null; body: string }
    >;
    const account = called['/account/'];
    const nonce = /'nonce-([^']+)'/.exec(account?.csp ?? '')?.[1];
    expect(account?.status).toBe(200);
    expect(account?.mode).toBe('nonce');
    expect(nonce).toBeTruthy();
    expect(account?.body).toContain('data-runner="host"');
    expect(account?.body).toContain(`data-nonce="${nonce}"`);
    const scripts = [...(account?.body ?? '').matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    // A path of the dynamic route that was not prerendered is rendered, with a nonce policy.
    expect(called['/blog/other/']?.status).toBe(200);
    expect(called['/blog/other/']?.mode).toBe('nonce');
    expect(JSON.parse(called['/api/ping']?.body ?? '{}')).toEqual({ runner: 'host' });
    expect(called['/_hypdriv/health']?.status).toBe(200);
    expect(called['/missing/']?.status).toBe(404);
  }, 240_000);

  it('writes the manifest after static generation, patches it into the Node server and serves through the pipeline', async () => {
    mkdirSync(buildsDir, { recursive: true });
    const root = mkdtempSync(join(buildsDir, 'node-'));
    created.push(root);
    fixture(root, 'node');
    const env = await qwikBuild(root, 'node');

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    const byId = Object.fromEntries(manifest.routes.map((r) => [r.id, r]));
    expect(manifest.framework).toMatchObject({ name: 'qwik', adapter: 'node', bundler: 'vite' });
    expect(manifest.framework?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(byId['page:/']?.classification).toBe('static');
    expect(byId['page:/about']?.classification).toBe('static');
    // The prerendered path of a dynamic route is a static page of its own; the route keeps rendering the rest.
    expect(byId['page:/blog/hello']?.classification).toBe('static');
    expect(byId['page:/blog/[slug]']?.classification).toBe('dynamic');
    expect(byId['page:/account']?.classification).toBe('dynamic');
    expect(byId['endpoint:/api/ping']?.classification).toBe('route');
    expect(manifest.csp['page:/account']).toBeUndefined();
    expect(manifest.csp['page:/blog/[slug]']).toBeUndefined();

    // Qwik prerendered the pages without Hypdriv: the hashes in the manifest cover every executable inline script.
    const home = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
    expect(home).not.toContain('nonce=');
    const inline = inlineScripts(home);
    expect(inline.length).toBeGreaterThan(0);
    for (const script of inline) expect(manifest.csp['page:/']?.scriptHashes).toContain(sha256(script));
    for (const file of ['about/index.html', 'blog/hello/index.html', 'robots.txt']) {
      expect(existsSync(join(root, 'dist', file)), file).toBe(true);
    }
    expect(existsSync(join(root, 'dist', 'account', 'index.html'))).toBe(false);

    // The final manifest is embedded in the server output.
    const server = readdirSync(join(root, 'server'), { recursive: true, encoding: 'utf8' }).filter(
      (file) =>
        file.endsWith('.js') && readFileSync(join(root, 'server', file), 'utf8').includes(manifest.buildId),
    );
    expect(server.length).toBeGreaterThan(0);

    // Serve the build in its own process: every response runs through the pipeline.
    const port = await freePort();
    const child = spawn(process.execPath, [join(root, 'server', 'entry.node.js')], {
      cwd: root,
      env: { ...env, PORT: String(port), HOST: '127.0.0.1' },
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
    expect(health.framework).toContain('Qwik');

    // Prerendered documents are the files Qwik wrote, under their hash policy.
    const homeResponse = await fetch(`${base}/`, { headers: browser });
    expect(homeResponse.status).toBe(200);
    expect(homeResponse.headers.get('x-hypdriv-csp')).toBe('hash');
    expect(homeResponse.headers.get('x-frame-options')).toBe('DENY');
    expect(homeResponse.headers.get('content-security-policy')).toContain('sha256-');
    expect(await homeResponse.text()).toBe(home);
    const about = await fetch(`${base}/about/`, { headers: browser });
    expect(about.status).toBe(200);
    expect(about.headers.get('x-hypdriv-csp')).toBe('hash');
    const hello = await fetch(`${base}/blog/hello/`, { headers: browser });
    expect(hello.headers.get('x-hypdriv-csp')).toBe('hash');
    expect(await hello.text()).toBe(readFileSync(join(root, 'dist', 'blog', 'hello', 'index.html'), 'utf8'));
    expect((await fetch(`${base}/robots.txt`, { headers: browser })).status).toBe(200);
    // The other spelling of a page is Qwik's redirect.
    const redirect = await fetch(`${base}/about`, { headers: browser, redirect: 'manual' });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/about/');

    // A page that renders per request: a nonce policy, and every script carries the nonce.
    const account = await fetch(`${base}/account/`, { headers: browser });
    const html = await account.text();
    const nonce = /'nonce-([^']+)'/.exec(account.headers.get('content-security-policy') ?? '')?.[1];
    expect(account.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(nonce).toBeTruthy();
    expect(html).toContain(`data-request-id="${account.headers.get('x-request-id')}"`);
    expect(html).toContain('data-runner="host"');
    expect(html).toContain(`data-nonce="${nonce}"`);
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    // An unlisted path of the dynamic route is rendered, not served from a file.
    const other = await fetch(`${base}/blog/other/`, { headers: browser });
    expect(other.status).toBe(200);
    expect(other.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(await other.text()).toContain('Post other');

    const ping = await fetch(`${base}/api/ping`, { headers: browser });
    expect(await ping.json()).toEqual({ runner: 'host' });
    expect(ping.headers.get('x-request-id')).toBeTruthy();
    expect((await fetch(`${base}/nowhere/`, { headers: browser })).status).toBe(404);

    // Qwik's hashed build files are immutable, and automation is stopped.
    const asset =
      /(?:href|src)="(\/build\/[^"]+\.js)"/.exec(home)?.[1] ?? /(\/build\/q-[^"'\s)]+\.js)/.exec(home)?.[1];
    expect(asset).toBeTruthy();
    const file = await fetch(`${base}${asset}`, { headers: { ...browser, accept: '*/*' } });
    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toMatch(/immutable/);
    // (`fetch` adds accept-language / sec-fetch-* headers a real curl never sends, which lowers the verdict.)
    expect(await statusOf(`${base}/account/`, { 'user-agent': 'curl/8.9.1', accept: 'text/html' })).toBe(403);
    expect(await statusOf(`${base}/about/`, { 'user-agent': 'curl/8.9.1', accept: 'text/html' })).toBe(403);
  }, 240_000);
});
