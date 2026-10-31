import { spawn } from 'node:child_process';
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HypManifest } from '@hypdriv/core';
import { afterAll, describe, expect, it } from 'vitest';
import { vercelFallbackDestination, writeVercelStaticPages } from './outputs';
import { hookModuleCode, VINEXT_RSC_ENTRY, vinextVersion } from './plugin';
import { PRERENDER_TOKEN_ENV } from './runtime';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
const buildsDir = join(packageDir, '.test-builds');
const created: string[] = [];

afterAll(() => {
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

describe('request hook module', () => {
  it('wraps vinext’s handler in builds and resolves it per request in development', () => {
    const build = hookModuleCode({ development: false });
    expect(build).toContain(`import handler from "${VINEXT_RSC_ENTRY}"`);
    expect(build).toContain(`export * from "${VINEXT_RSC_ENTRY}"`);
    expect(build).toContain('export default wrapAppHandler(handler, { config, manifest })');
    const dev = hookModuleCode({ development: true });
    expect(dev).toContain(`import(${JSON.stringify(VINEXT_RSC_ENTRY)})`);
    expect(dev).toContain('{ load: true }');
    expect(dev).toContain('import.meta.hot.accept()');
  });

  it('finds the installed vinext version', () => {
    expect(vinextVersion(packageDir)).toMatch(/^\d+\.\d+\.\d+/);
    expect(vinextVersion('/')).toBe('unknown');
  });
});

describe('Vercel static pages', () => {
  it('copies prerendered pages into the Build Output and routes RSC and actions to the function', () => {
    mkdirSync(buildsDir, { recursive: true });
    const root = mkdtempSync(join(buildsDir, 'vercel-'));
    created.push(root);
    const out = join(root, '.vercel', 'output');
    write(root, {
      'doc/index.html': '<html>home</html>',
      'doc/about.html': '<html>about</html>',
      '.vercel/output/static/robots.txt': 'User-agent: *',
      '.vercel/output/static/legal.html': '<html>public legal</html>',
      '.vercel/output/config.json': JSON.stringify({
        version: 3,
        overrides: {},
        routes: [
          { src: '^/_next/static/(.*)$', headers: { 'cache-control': 'immutable' }, continue: true },
          { handle: 'filesystem' },
          { src: '/(.*)', dest: '/__server' },
        ],
      }),
    });
    const pages = [
      { pathname: '/', file: join(root, 'doc/index.html') },
      { pathname: '/about', file: join(root, 'doc/about.html') },
      // A public file of the same name is never shadowed.
      { pathname: '/legal', file: join(root, 'doc/index.html') },
    ];
    const copied = writeVercelStaticPages({ outputDir: out, pages });
    expect(copied.map((p) => p.pathname)).toEqual(['/', '/about']);
    // Idempotent: a second run replaces its own routes.
    writeVercelStaticPages({ outputDir: out, pages });
    const config = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8'));
    expect(readFileSync(join(out, 'static', 'about.html'), 'utf8')).toBe('<html>about</html>');
    expect(readFileSync(join(out, 'static', 'robots.txt'), 'utf8')).toBe('User-agent: *');
    expect(config.overrides).toEqual({
      'about.html': { path: 'about', contentType: 'text/html; charset=utf-8' },
    });
    const fs = config.routes.findIndex((r: { handle?: string }) => r.handle === 'filesystem');
    const own = config.routes.filter((r: { dest?: string }) => r.dest === '/__server');
    expect(own).toHaveLength(4);
    expect(config.routes.slice(1, fs)).toEqual([
      { src: '^/(?:|about)/?$', has: [{ type: 'header', key: 'rsc' }], dest: '/__server', check: true },
      {
        src: '^/(?:|about)/?$',
        has: [{ type: 'header', key: 'next-action' }],
        dest: '/__server',
        check: true,
      },
      { src: '^/(?:|about)/?$', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], dest: '/__server', check: true },
    ]);
    expect(vercelFallbackDestination(config.routes)).toBe('/__server');
    expect(vercelFallbackDestination([{ src: '/(.*)', dest: '/x' }])).toBeNull();
  });
});

const page = (body: string) => `export default function Page() { return ${body}; }\n`;

describe('a real vinext build', () => {
  it('finalises the manifest after vinext’s prerender, patches it into the server and serves through the hook', async () => {
    mkdirSync(buildsDir, { recursive: true });
    const root = mkdtempSync(join(buildsDir, 'node-'));
    created.push(root);
    write(root, {
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
      'app/layout.tsx':
        'export default function Root({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html>; }\n',
      'app/page.tsx': page('<main><h1>Home</h1></main>'),
      'app/news/page.tsx': `export const revalidate = 60;\n${page('<p>news</p>')}`,
      'app/account/page.tsx': `import { hyp } from '@hypdriv/vinext/server';\nexport default function Account() { const c = hyp(); return <p id="facts">{c?.requestId}|{c?.runner}|{c?.nonce}</p>; }\n`,
      'app/api/ping/route.ts': `import { hyp } from '@hypdriv/vinext/server';\nexport function GET() { return Response.json({ runner: hyp()?.runner ?? null }); }\n`,
    });
    const { createBuilder } = await import('vite');
    const { default: vinext } = await import('vinext');
    const { hypdriv } = await import('./plugin');
    const alias = {
      '@hypdriv/vinext/server': join(packageDir, 'src', 'server.ts'),
      '@hypdriv/vinext/runtime': join(packageDir, 'src', 'runtime.ts'),
      '@hypdriv/vinext/cache': join(packageDir, 'src', 'cache.ts'),
    };
    const previousCwd = process.cwd();
    const previousArgv = process.argv;
    process.chdir(root);
    // vinext runs its post-build lifecycle (prerender, cache packaging) for a `vite build` command line.
    process.argv = [process.execPath, join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'];
    try {
      const builder = await createBuilder({
        root,
        configFile: false,
        logLevel: process.env.HYPDRIV_KEEP_TEST_BUILDS ? 'info' : 'error',
        resolve: { alias },
        plugins: [
          vinext({ prerender: true }),
          hypdriv({ target: 'node', config: { site: { name: 'fixture' } } }),
        ],
      });
      await builder.buildApp();
    } finally {
      process.argv = previousArgv;
      process.chdir(previousCwd);
    }

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    const byId = Object.fromEntries(manifest.routes.map((r) => [r.id, r]));
    expect(manifest.framework).toMatchObject({ name: 'vinext', adapter: 'node', bundler: 'vite' });
    expect(manifest.buildId).toBe(readFileSync(join(root, 'dist', 'server', 'BUILD_ID'), 'utf8').trim());
    expect(byId['page:/']?.classification).toBe('static');
    expect(byId['page:/news']?.classification).toBe('isr');
    expect(byId['page:/account']?.classification).toBe('dynamic');
    expect(byId['endpoint:/api/ping']?.classification).toBe('route');
    expect(manifest.csp['page:/']?.scriptHashes.length).toBeGreaterThan(0);
    expect(manifest.csp['page:/news']).toBeUndefined();

    // vinext prerendered the pages without HypDriv (no nonce, no request context).
    const home = readFileSync(join(root, 'dist', 'server', 'prerendered-routes', 'index.html'), 'utf8');
    expect(home).not.toContain('nonce=');
    const inline = [...home.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`,
    );
    expect(inline.length).toBeGreaterThan(0);
    for (const hash of inline) expect(manifest.csp['page:/']?.scriptHashes).toContain(hash);

    // The final manifest is embedded in the server output; the token never leaks into it as an env value.
    const server = readFileSync(join(root, 'dist', 'server', 'index.js'), 'utf8');
    expect(server).toContain(`\\"buildId\\":\\"${manifest.buildId}\\"`);
    expect(server).toContain('page:/news');
    const token = process.env[PRERENDER_TOKEN_ENV]!;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(server).toContain(token);
    const clientFiles = readdirSync(join(root, 'dist', 'client'), { recursive: true, encoding: 'utf8' });
    for (const file of clientFiles.filter((f) => f.endsWith('.js')))
      expect(readFileSync(join(root, 'dist', 'client', file), 'utf8')).not.toContain(token);
    expect(existsSync(join(root, '.hypdriv', 'report.md'))).toBe(true);

    // Serve the build with vinext's production server (`vinext start`) in its own process: every response runs
    // through the hook.
    const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'production' };
    delete env[PRERENDER_TOKEN_ENV];
    delete env.VITEST;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { startProdServer } = await import('vinext/server/prod-server');
           const { port } = await startProdServer({ port: 0, host: '127.0.0.1', outDir: ${JSON.stringify(join(root, 'dist'))}, silent: true });
           console.log('PORT=' + port);`,
      ],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const port = await new Promise<number>((done, fail) => {
      let out = '';
      const timer = setTimeout(() => fail(new Error(`server did not start: ${out}`)), 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const match = /PORT=(\d+)/.exec(out);
        if (match) {
          clearTimeout(timer);
          done(Number(match[1]));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.on('exit', (code) => fail(new Error(`server exited (${code}): ${out}`)));
    });
    try {
      const browser = {
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        accept: 'text/html',
        'accept-language': 'en-US',
      };
      const base = `http://127.0.0.1:${port}`;
      const health = (await (await fetch(`${base}/_hypdriv/health`, { headers: browser })).json()) as {
        runner: string;
        framework: string;
      };
      expect(health.runner).toBe('host');
      expect(health.framework).toContain('vinext');

      const homeResponse = await fetch(`${base}/`, { headers: browser });
      expect(homeResponse.headers.get('x-hypdriv-csp')).toBe('hash');
      expect(await homeResponse.text()).toBe(home);

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

      const ping = await fetch(`${base}/api/ping`, { headers: browser });
      expect(await ping.json()).toEqual({ runner: 'host' });
      expect(ping.headers.get('x-request-id')).toBeTruthy();
    } finally {
      child.kill();
    }
  }, 180_000);
});
