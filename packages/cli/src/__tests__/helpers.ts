import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HypManifest, resolveConfig } from '@hypdriv/core';
import { buildManifest, createNodeFs, type OnBuildCompleteContext, rerootPaths } from '@hypdriv/next/adapter';
import { createMemoryIO, type MemoryIO, type MemoryIOOptions } from '../io';

export interface TempProject {
  dir: string;
  write(path: string, content: string): void;
  read(path: string): string;
  cleanup(): void;
}

const created: TempProject[] = [];

/** Creates a temporary project directory with the given files. */
export function tempProject(files: Record<string, string> = {}): TempProject {
  const dir = mkdtempSync(join(tmpdir(), 'hypdriv-cli-'));
  const project: TempProject = {
    dir,
    write(path, content) {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    read: (path) => readFileSync(join(dir, path), 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  for (const [path, content] of Object.entries(files)) project.write(path, content);
  created.push(project);
  return project;
}

export function cleanupProjects(): void {
  for (const p of created.splice(0)) p.cleanup();
}

/** `node_modules/<name>/package.json` with a version. */
export function installed(
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
): Record<string, string> {
  return { [`node_modules/${name}/package.json`]: JSON.stringify({ name, version, ...extra }) };
}

export const WRANGLER_JSONC = `{
  // The Worker name
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "shop",
  "main": ".open-next/worker.js", // OpenNext's default entry
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  /* static assets */
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "shop" }],
}
`;

/** A typical OpenNext Cloudflare project before `hypdriv init`. */
export function openNextProject(overrides: Record<string, string> = {}): TempProject {
  return tempProject({
    'package.json': JSON.stringify(
      {
        name: '@acme/shop',
        version: '1.0.0',
        type: 'module',
        packageManager: 'pnpm@10.0.0',
        scripts: { dev: 'next dev', build: 'next build' },
        dependencies: {
          next: '16.4.3',
          react: '^19.3.1',
          'react-dom': '^19.3.1',
          '@opennextjs/cloudflare': '^1.20.0',
        },
        devDependencies: { typescript: '^6.0.3', wrangler: '^4.156.0' },
      },
      null,
      2,
    ),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    ...installed('next', '16.4.3', { peerDependencies: {} }),
    ...installed('react', '19.3.1'),
    ...installed('typescript', '6.0.3'),
    ...installed('wrangler', '4.156.0'),
    ...installed('@opennextjs/cloudflare', '1.20.14', {
      peerDependencies: { next: '>=15.5.28 <16 || >=16.4.1' },
    }),
    'wrangler.jsonc': WRANGLER_JSONC,
    'open-next.config.ts':
      "import { defineCloudflareConfig } from '@opennextjs/cloudflare';\nexport default defineCloudflareConfig({});\n",
    'next.config.ts': `import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {\n  reactStrictMode: true,\n};\n\nexport default nextConfig;\n\nimport { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';\ninitOpenNextCloudflareForDev();\n`,
    'tsconfig.json': `{\n  // app config\n  "compilerOptions": { "strict": true },\n  "include": ["**/*.ts", "**/*.tsx"],\n  "exclude": ["node_modules"]\n}\n`,
    'app/layout.tsx':
      'export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n',
    'app/page.tsx': 'export default function Page() { return <h1>Hi</h1>; }\n',
    '.gitignore': 'node_modules\n.dev.vars\n',
    ...overrides,
  });
}

/** Memory IO rooted at a project, with a fake fetch that fails unless provided. */
export function memoryIO(cwd: string, options: MemoryIOOptions = {}): MemoryIO {
  return createMemoryIO({
    ...options,
    cwd,
    env: { NO_COLOR: '1', HYPDRIV_OFFLINE: '1', ...(options.env ?? {}) },
  });
}

const fixtureDir = fileURLToPath(
  new URL('../../../next/src/adapter/__fixtures__/next-16.4/', import.meta.url),
).replace(/\/$/, '');

/** Builds the HypDriv manifest from the captured Next 16.4 build (the same fixture the adapter tests use). */
export async function fixtureManifest(
  config: Parameters<typeof resolveConfig>[0] = {},
): Promise<HypManifest> {
  const raw = JSON.parse(
    readFileSync(join(fixtureDir, 'onBuildComplete.json'), 'utf8'),
  ) as OnBuildCompleteContext;
  const context = rerootPaths(raw, fixtureDir);
  const { manifest } = await buildManifest({
    context,
    config: resolveConfig(config),
    fs: createNodeFs(),
    hypdrivVersion: '0.0.0-test',
    now: () => new Date('2026-10-30T00:00:00Z'),
  });
  return manifest;
}

/** A Response factory for fake fetch implementations. */
export function response(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
}

/** Builds a fetch fake from a handler; records calls. */
export function fakeFetch(
  handler: (url: string, init: RequestInit & { request?: Request }) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const headers = new Headers(request ? request.headers : (init.headers as HeadersInit | undefined));
    const method = (request ? request.method : init.method) ?? 'GET';
    const body = request ? await request.clone().text() : typeof init.body === 'string' ? init.body : null;
    calls.push({ url, method, headers, body });
    return handler(url, { ...init, ...(request ? { request } : {}) });
  }) as typeof fetch;
  return { fetch: fn, calls };
}
