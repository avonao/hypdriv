import { type ChildProcess, execFile, spawn } from 'node:child_process';
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

afterAll(async () => {
  // Stop each preview server by its own process id, then wait for it to go.
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((done) => {
          if (child.exitCode !== null) return done();
          child.once('exit', () => done());
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
          }, 10_000).unref();
        }),
    ),
  );
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

// RedwoodSDK needs a Node that Vite 8 supports (this package's `engines`).
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && minor >= 12);

const source = (file: string) => JSON.stringify(join(packageDir, 'src', file));

/**
 * The fixture application of the real builds: a home page with a client component, a static page, a dynamic route
 * and an API route, built by the real `redwood()` and Cloudflare plugins with the Hypdriv plugin last.
 */
function fixture(root: string, variant: 'full' | 'no-middleware'): void {
  const middleware = variant === 'full';
  write(root, {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        paths: { '@/*': ['./src/*'] },
      },
    }),
    'wrangler.jsonc': `{
  "name": "hypdriv-rwsdk-fixture",
  "main": "src/worker.tsx",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "binding": "ASSETS", "run_worker_first": ["/*", "!/assets/*"] },
  "durable_objects": {
    "bindings": [
      { "name": "HYPDRIV_LIMITER", "class_name": "HypDrivLimiter" },
      { "name": "HYPDRIV_INDEX", "class_name": "HypDrivIndex" },
      { "name": "HYPDRIV_CHANNEL", "class_name": "HypDrivChannel" }
    ]
  },
  "migrations": [
    { "tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel", "HypDrivLimiter", "HypDrivIndex"] }
  ]
}
`,
    'vite.config.mts': [
      "import { cloudflare } from '@cloudflare/vite-plugin';",
      `import { hypdriv } from ${source('index')};`,
      "import { redwood } from 'rwsdk/vite';",
      "import { defineConfig } from 'vite';",
      'export default defineConfig({',
      '  environments: { ssr: {} },',
      '  resolve: {',
      '    alias: {',
      `      '@hypdriv/rwsdk/worker': ${source('worker')},`,
      `      '@hypdriv/rwsdk/server': ${source('server')},`,
      `      '@hypdriv/rwsdk/durable-objects': ${source('durable-objects')},`,
      '    },',
      '  },',
      "  plugins: [cloudflare({ viteEnvironment: { name: 'worker' } }), redwood(), hypdriv()],",
      '});',
      '',
    ].join('\n'),
    'hypdriv.config.ts': [
      "import { defineConfig } from '@hypdriv/core';",
      'export default defineConfig({',
      "  site: { name: 'fixture' },",
      "  security: { bots: { definitelyAutomated: 'block' } },",
      '});',
      '',
    ].join('\n'),
    'src/worker.tsx': [
      "import { hyp } from '@hypdriv/rwsdk/server';",
      `import { ${middleware ? 'hypdrivMiddleware, ' : ''}withHypDriv } from '@hypdriv/rwsdk/worker';`,
      "import { prefix, render, route } from 'rwsdk/router';",
      "import { defineApp } from 'rwsdk/worker';",
      "import { Document } from '@/app/Document';",
      "import { About } from '@/app/pages/About';",
      "import { Home } from '@/app/pages/Home';",
      "import { Product } from '@/app/pages/Product';",
      'export default withHypDriv(',
      '  defineApp([',
      ...(middleware ? ['    hypdrivMiddleware(),'] : []),
      '    render(Document, [',
      "      route('/', Home),",
      "      route('/about', About),",
      "      prefix('/products', [route('/:id', Product)]),",
      '    ]),',
      "    route('/api/ping', { get: () => Response.json({ runner: hyp()?.runner ?? null }) }),",
      '  ]),',
      ');',
      '',
    ].join('\n'),
    'src/client.tsx': "import { initClient } from 'rwsdk/client';\ninitClient();\n",
    'src/app/styles.css': 'body { font-family: system-ui, sans-serif; }\n',
    'src/app/Document.tsx': [
      "import type { DocumentProps } from 'rwsdk/router';",
      "import styles from './styles.css?url';",
      'export const Document = ({ children }: DocumentProps) => (',
      '  <html lang="en">',
      '    <head>',
      '      <meta charSet="utf-8" />',
      '      <title>Fixture</title>',
      '      <link rel="stylesheet" href={styles} />',
      '      <link rel="modulepreload" href="/src/client.tsx" />',
      '    </head>',
      '    <body>',
      '      <div id="root">{children}</div>',
      '      <script>import("/src/client.tsx")</script>',
      '    </body>',
      '  </html>',
      ');',
      '',
    ].join('\n'),
    'src/app/Counter.tsx':
      "'use client';\nimport { useState } from 'react';\nexport function Counter() { const [n, setN] = useState(0); return <button type=\"button\" onClick={() => setN(n + 1)}>{n}</button>; }\n",
    'src/app/pages/Home.tsx':
      "import { Counter } from '@/app/Counter';\nexport const Home = () => <main><h1>Home</h1><Counter /></main>;\n",
    'src/app/pages/About.tsx': 'export const About = () => <main><h1>About</h1></main>;\n',
    'src/app/pages/Product.tsx': [
      "import { hyp } from '@hypdriv/rwsdk/server';",
      "import type { RequestInfo } from 'rwsdk/worker';",
      'export const Product = ({ params }: RequestInfo<{ id: string }>) => {',
      '  const c = hyp();',
      '  return <p id="facts">product {params.id}|{c?.requestId}|{c?.runner}|{c?.route}|{c?.nonce}</p>;',
      '};',
      '',
    ].join('\n'),
    'public/robots.txt': 'User-agent: *\n',
  });
}

/** Runs `vite build` of the fixture; resolves with everything the build printed. */
async function viteBuild(root: string): Promise<{ output: string; env: Record<string, string | undefined> }> {
  const bin = join(packageDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } as Record<string, string | undefined>;
  // Vitest sets these; they would make the child build behave like a test run.
  delete env.VITEST;
  delete env.NODE_ENV;
  delete env.CLAUDE_CODE_SESSION_ID;
  const { stdout, stderr } = await run(process.execPath, [bin, 'build'], {
    cwd: root,
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { output: `${stdout}\n${stderr}`, env };
}

function newRoot(name: string): string {
  mkdirSync(buildsDir, { recursive: true });
  const root = mkdtempSync(join(buildsDir, `${name}-`));
  created.push(root);
  return root;
}

const files = (dir: string) => readdirSync(dir, { recursive: true, encoding: 'utf8' });

describe.skipIf(!supported)('a real RedwoodSDK build', () => {
  it('writes the manifest, patches it into the Worker, exports the Durable Objects and serves through the pipeline', async () => {
    const root = newRoot('full');
    fixture(root, 'full');
    const { output, env } = await viteBuild(root);

    // A complete application sets nothing off.
    expect(output).not.toContain('withHypDriv()');
    expect(output).not.toContain('hypdrivMiddleware()');
    expect(output).not.toContain('could not all be read');
    expect(output).toContain('final manifest patched into');

    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    expect(manifest.framework).toMatchObject({ name: 'rwsdk', adapter: 'cloudflare', bundler: 'vite' });
    expect(manifest.framework?.version).toMatch(/^1\.\d+\.\d+/);
    const byId = Object.fromEntries(manifest.routes.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual([
      'endpoint:/api/ping',
      'page:/',
      'page:/about',
      'page:/products/[id]',
    ]);
    // Every page is rendered per request: nothing is prerendered, so no hash CSP.
    expect(byId['page:/']?.classification).toBe('dynamic');
    expect(byId['page:/products/[id]']?.dynamic).toBe(true);
    expect(byId['endpoint:/api/ping']?.classification).toBe('route');
    expect(byId['page:/']?.sourcePage).toBe('src/worker.tsx');
    expect(manifest.csp).toEqual({});
    expect(manifest.staticFiles?.immutablePrefixes).toEqual(['/assets/']);

    // The static side: hashed assets are immutable (`_headers`), and nothing of the build is served as an asset.
    const client = join(root, 'dist', 'client');
    const headers = readFileSync(join(client, '_headers'), 'utf8');
    expect(headers).toMatch(/\/assets\/\*[\s\S]*cache-control: public, max-age=31536000, immutable/i);
    expect(existsSync(join(client, '.assetsignore'))).toBe(true);
    expect(existsSync(join(client, 'robots.txt'))).toBe(true);

    // The final manifest is embedded in the built Worker, which exports the Durable Object classes.
    const workerDir = join(root, 'dist', 'worker');
    const workerFiles = files(workerDir).filter((file) => /\.m?js$/.test(file));
    const embedding = workerFiles.filter((file) =>
      readFileSync(join(workerDir, file), 'utf8').includes(manifest.buildId),
    );
    expect(embedding.length).toBeGreaterThan(0);
    const entry = readFileSync(join(workerDir, 'index.js'), 'utf8');
    for (const name of ['HypDrivLimiter', 'HypDrivIndex', 'HypDrivChannel'])
      expect(entry).toMatch(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`));
    const wrangler = JSON.parse(readFileSync(join(workerDir, 'wrangler.json'), 'utf8')) as {
      assets?: { run_worker_first?: unknown };
      durable_objects?: { bindings?: Array<{ name: string }> };
    };
    expect(wrangler.assets?.run_worker_first).toEqual(['/*', '!/assets/*']);
    expect(wrangler.durable_objects?.bindings?.map((b) => b.name)).toEqual([
      'HYPDRIV_LIMITER',
      'HYPDRIV_INDEX',
      'HYPDRIV_CHANNEL',
    ]);

    // Serve the build in workerd (`vite preview`): every response runs through the pipeline.
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [
        join(packageDir, 'node_modules', 'vite', 'bin', 'vite.js'),
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    let log = '';
    child.stdout.on('data', (chunk: Buffer) => {
      log += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      log += chunk.toString();
    });
    const base = `http://127.0.0.1:${port}`;
    const started = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`preview exited (${child.exitCode}): ${log}`);
      try {
        if ((await fetch(`${base}/_hypdriv/health`, { headers: browser })).ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() - started > 60_000) throw new Error(`preview did not start: ${log}`);
      await new Promise((r) => setTimeout(r, 200));
    }

    const health = (await (await fetch(`${base}/_hypdriv/health`, { headers: browser })).json()) as {
      runner: string;
      framework: string;
    };
    expect(health.runner).toBe('worker');
    expect(health.framework).toContain('RedwoodSDK');

    // Every page: the nonce CSP allows every script RedwoodSDK renders (the middleware handed it the nonce).
    for (const path of ['/', '/about', '/products/42']) {
      const response = await fetch(`${base}${path}`, { headers: browser });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('x-frame-options'), path).toBe('DENY');
      expect(response.headers.get('x-hypdriv-rwsdk'), path).toBeNull();
      const csp = response.headers.get('content-security-policy') ?? '';
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce, path).toBeTruthy();
      expect(csp, path).toContain("'strict-dynamic'");
      const html = await response.text();
      // (Speculation rules are data, not script: the Drivetrain's own block has its own CSP allowance.)
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)]
        .map((m) => m[0])
        .filter((tag) => !tag.includes('type="speculationrules"'));
      expect(scripts.length, path).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag, path).toContain(`nonce="${nonce}"`);
    }

    // The request context reaches server components: the facts of the dynamic page are this request's.
    const product = await fetch(`${base}/products/42`, { headers: browser });
    const facts = /<p id="facts">([\s\S]*?)<\/p>/.exec(
      (await product.text()).replaceAll('<!-- -->', ''),
    )?.[1];
    const nonce = /'nonce-([^']+)'/.exec(product.headers.get('content-security-policy') ?? '')?.[1];
    expect(facts).toBe(
      `product 42|${product.headers.get('x-request-id')}|worker|page:/products/[id]|${nonce}`,
    );

    const ping = await fetch(`${base}/api/ping`, { headers: browser });
    expect(await ping.json()).toEqual({ runner: 'worker' });
    expect(ping.headers.get('x-request-id')).toBeTruthy();

    // Public files come from the assets binding, behind the same pipeline.
    const robots = await fetch(`${base}/robots.txt`, { headers: { ...browser, accept: '*/*' } });
    expect(robots.status).toBe(200);
    expect(robots.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await robots.text()).toBe('User-agent: *\n');

    // RedwoodSDK's hashed assets keep their immutable cache header.
    const cssPath = /href="(\/assets\/[^"]+\.css)"/.exec(
      await (await fetch(`${base}/about`, { headers: browser })).text(),
    )?.[1];
    expect(cssPath).toBeTruthy();
    const css = await fetch(`${base}${cssPath}`, { headers: { ...browser, accept: 'text/css' } });
    expect(css.status).toBe(200);
    expect(css.headers.get('cache-control')).toMatch(/immutable/);

    // Automation is stopped before RedwoodSDK. (`fetch` adds headers a real curl never sends, so use `http`; the
    // preview proxy marks requests `sec-fetch-mode: cors`, which `navigate` replaces here.)
    expect(
      await statusOf(`${base}/about`, {
        'user-agent': 'curl/8.9.1',
        accept: 'text/html',
        'sec-fetch-mode': 'navigate',
      }),
    ).toBe(403);
  }, 300_000);

  it('warns at build time when the Worker has no hypdrivMiddleware()', async () => {
    const root = newRoot('no-middleware');
    fixture(root, 'no-middleware');
    const { output } = await viteBuild(root);
    expect(output).toContain('hypdrivMiddleware()');
    expect(output).toContain('Put hypdrivMiddleware() first');
    // The routes are still discovered and the manifest is still patched into the Worker.
    const manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    expect(manifest.routes.map((r) => r.id).sort()).toEqual([
      'endpoint:/api/ping',
      'page:/',
      'page:/about',
      'page:/products/[id]',
    ]);
    expect(output).toContain('final manifest patched into');
  }, 300_000);
});
