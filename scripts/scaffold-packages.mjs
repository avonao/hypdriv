#!/usr/bin/env node
// One-time generator for package boilerplate (package.json, tsconfig, tsdown, vitest, README stub).
// Idempotent: existing files are left untouched unless --force is passed.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const force = process.argv.includes('--force');
const root = new URL('../packages/', import.meta.url).pathname;

const common = {
  license: 'MIT',
  author: 'Avonao',
  homepage: 'https://hypdriv.dev',
  bugs: 'https://github.com/avonao/hypdriv/issues',
  type: 'module',
  sideEffects: false,
  engines: { node: '>=20.9' },
  files: ['dist', 'README.md', 'LICENSE'],
};

/** @type {Record<string, {name:string, description:string, entries:Record<string,string>, deps?:Record<string,string>, peer?:Record<string,string>, peerMeta?:Record<string,{optional:boolean}>, dev?:Record<string,string>, platform?:'neutral'|'node'|'browser', workers?:boolean, react?:boolean, bin?:Record<string,string>, types?:string[], keywords?:string[]}>} */
const packages = {
  cache: {
    name: '@hypdriv/cache',
    description: 'HypDriv edge cache engine: policies, normalised keys, SWR, coalescing, tags and purge over Cache API, memory or KV stores.',
    entries: { index: 'src/index.ts' },
    deps: { '@hypdriv/core': 'workspace:*' },
    workers: true,
  },
  security: {
    name: '@hypdriv/security',
    description: 'HypDriv security primitives: CSP autopilot, security headers, rate limiting, bot shield, safe actions, encrypted sessions, JWT, signing, webhooks, secrets scan.',
    entries: { index: 'src/index.ts', node: 'src/node/index.ts' },
    deps: { '@hypdriv/core': 'workspace:*' },
    peer: { '@standard-schema/spec': '^1.1.0' },
    peerMeta: { '@standard-schema/spec': { optional: true } },
    dev: { '@standard-schema/spec': 'catalog:' },
  },
  observe: {
    name: '@hypdriv/observe',
    description: 'HypDriv observability: tracing with OTLP export, structured logging, Server-Timing and Web Vitals collection.',
    entries: { index: 'src/index.ts', client: 'src/client/index.ts' },
    deps: { '@hypdriv/core': 'workspace:*' },
    peer: { 'web-vitals': '^5.0.0 || ^6.0.0' },
    peerMeta: { 'web-vitals': { optional: true } },
    dev: { 'web-vitals': 'catalog:' },
  },
  flags: {
    name: '@hypdriv/flags',
    description: 'HypDriv edge feature flags: deterministic bucketing, geo/cookie/percentage rules, providers (static, env, KV, OpenFeature) and React hooks.',
    entries: { index: 'src/index.ts', react: 'src/react/index.tsx' },
    deps: { '@hypdriv/core': 'workspace:*' },
    peer: { react: '^19.0.0' },
    peerMeta: { react: { optional: true } },
    react: true,
  },
  live: {
    name: '@hypdriv/live',
    description: 'HypDriv live channels: Durable Object pub/sub with WebSocket hibernation and SSE, polling fallback, and the useLive React hook.',
    entries: { index: 'src/index.ts', react: 'src/react/index.tsx', 'durable-object': 'src/durable-object/index.ts' },
    deps: { '@hypdriv/core': 'workspace:*' },
    peer: { react: '^19.0.0' },
    peerMeta: { react: { optional: true } },
    react: true,
    workers: true,
  },
  image: {
    name: '@hypdriv/image',
    description: 'HypDriv images: Cloudflare image loader for next/image, placeholder generation and the HypImage component.',
    entries: { index: 'src/index.ts', loader: 'src/loader.ts', react: 'src/react/index.tsx', node: 'src/node/index.ts' },
    deps: { '@hypdriv/core': 'workspace:*' },
    peer: { next: '>=16.0.0', react: '^19.0.0', sharp: '>=0.33.0' },
    peerMeta: { next: { optional: true }, react: { optional: true }, sharp: { optional: true } },
    react: true,
  },
  purser: {
    name: '@hypdriv/purser',
    description: 'HypDriv bridge for Purser CSS: in-process build/watch, unstyled-atom guard, atom usage reports, edge theme pinning and zero-override audits.',
    entries: { index: 'src/index.ts', node: 'src/node/index.ts' },
    deps: { '@hypdriv/core': 'workspace:*' },
  },
  next: {
    name: '@hypdriv/next',
    description: 'HypDriv for Next.js 16+: withHypDriv config wrapper, adapter chain, proxy composables, server helpers and client components.',
    entries: {
      index: 'src/index.ts',
      config: 'src/config/index.ts',
      adapter: 'src/adapter/index.ts',
      proxy: 'src/proxy/index.ts',
      server: 'src/server/index.ts',
      client: 'src/client/index.tsx',
      cache: 'src/cache/index.ts',
      instrumentation: 'src/instrumentation/index.ts',
      stages: 'src/stages/index.ts',
    },
    deps: {
      '@hypdriv/core': 'workspace:*',
      '@hypdriv/cache': 'workspace:*',
      '@hypdriv/security': 'workspace:*',
      '@hypdriv/observe': 'workspace:*',
      '@hypdriv/flags': 'workspace:*',
      '@hypdriv/purser': 'workspace:*',
    },
    peer: { next: '>=16.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
    peerMeta: { react: { optional: false }, 'react-dom': { optional: true } },
    dev: { next: 'catalog:', react: 'catalog:', 'react-dom': 'catalog:', '@types/react': 'catalog:', '@types/react-dom': 'catalog:' },
    react: true,
  },
  cloudflare: {
    name: '@hypdriv/cloudflare',
    description: 'HypDriv Worker shell for OpenNext on Cloudflare: Drivetrain pipeline, scheduled/queue/email/tail handlers, Durable Objects and binding adapters.',
    entries: { index: 'src/index.ts', 'durable-objects': 'src/durable-objects/index.ts', context: 'src/context.ts' },
    deps: {
      '@hypdriv/core': 'workspace:*',
      '@hypdriv/next': 'workspace:*',
      '@hypdriv/cache': 'workspace:*',
      '@hypdriv/security': 'workspace:*',
      '@hypdriv/observe': 'workspace:*',
      '@hypdriv/flags': 'workspace:*',
      '@hypdriv/live': 'workspace:*',
      '@hypdriv/purser': 'workspace:*',
    },
    peer: { '@opennextjs/cloudflare': '>=1.15.0' },
    peerMeta: { '@opennextjs/cloudflare': { optional: true } },
    workers: true,
  },
  devtools: {
    name: '@hypdriv/devtools',
    description: 'HypDriv DevTools HUD: an in-app panel that reads Server-Timing, Web Vitals, flags and Purser diagnostics.',
    entries: { index: 'src/index.tsx' },
    deps: { '@hypdriv/core': 'workspace:*' },
    peer: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    react: true,
    platform: 'browser',
  },
  testing: {
    name: '@hypdriv/testing',
    description: 'HypDriv testing kit: fake bindings (KV, R2, Durable Objects, Queues), request builders, pipeline harness and vitest presets.',
    entries: { index: 'src/index.ts', vitest: 'src/vitest.ts' },
    deps: { '@hypdriv/core': 'workspace:*' },
    peer: { vitest: '>=3.0.0' },
    peerMeta: { vitest: { optional: true } },
    workers: true,
  },
  cli: {
    name: '@hypdriv/cli',
    description: 'The hypdriv command: init, doctor, analyze, routes, audit, budget, csp, css, warm, bench, deps, manifest.',
    entries: { index: 'src/index.ts', bin: 'src/bin.ts' },
    deps: { '@hypdriv/core': 'workspace:*', '@hypdriv/security': 'workspace:*', '@hypdriv/purser': 'workspace:*', '@hypdriv/next': 'workspace:*' },
    bin: { hypdriv: './dist/bin.js' },
    platform: 'node',
  },
  'create-hypdriv': {
    name: 'create-hypdriv',
    description: 'Scaffold a Next.js 16 app on Cloudflare Workers with OpenNext and HypDriv (and optionally Purser CSS).',
    entries: { index: 'src/index.ts' },
    bin: { 'create-hypdriv': './dist/index.js' },
    platform: 'node',
  },
  hypdriv: {
    name: 'hypdriv',
    description: 'HypDriv — the Hyper-Extension for Next.js 16+ on Cloudflare Workers. Umbrella package re-exporting every @hypdriv/* module and the hypdriv CLI.',
    entries: { index: 'src/index.ts', config: 'src/config.ts', next: 'src/next.ts', cloudflare: 'src/cloudflare.ts', server: 'src/server.ts', client: 'src/client.tsx' },
    deps: {
      '@hypdriv/core': 'workspace:*',
      '@hypdriv/next': 'workspace:*',
      '@hypdriv/cloudflare': 'workspace:*',
      '@hypdriv/cache': 'workspace:*',
      '@hypdriv/security': 'workspace:*',
      '@hypdriv/observe': 'workspace:*',
      '@hypdriv/flags': 'workspace:*',
      '@hypdriv/live': 'workspace:*',
      '@hypdriv/image': 'workspace:*',
      '@hypdriv/purser': 'workspace:*',
      '@hypdriv/devtools': 'workspace:*',
      '@hypdriv/cli': 'workspace:*',
    },
    bin: { hypdriv: './bin/hypdriv.js' },
    peer: { next: '>=16.0.0', react: '^19.0.0' },
    peerMeta: { next: { optional: true }, react: { optional: true } },
    react: true,
  },
};

function write(file, content) {
  if (existsSync(file) && !force) return false;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
  return true;
}

for (const [dir, spec] of Object.entries(packages)) {
  const pkgDir = join(root, dir);
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  const exportsMap = { './package.json': './package.json' };
  for (const [entry, src] of Object.entries(spec.entries)) {
    const key = entry === 'index' ? '.' : `./${entry}`;
    exportsMap[key] = {
      source: `./${src}`,
      types: `./dist/${entry}.d.ts`,
      default: `./dist/${entry}.js`,
    };
  }
  const ordered = { '.': exportsMap['.'] };
  for (const [k, v] of Object.entries(exportsMap)) if (k !== '.') ordered[k] = v;

  const devDeps = {
    '@types/node': 'catalog:',
    tsdown: 'catalog:',
    typescript: 'catalog:',
    vitest: 'catalog:',
    ...(spec.workers ? { '@cloudflare/workers-types': 'catalog:', '@cloudflare/vitest-plugin': 'catalog:', wrangler: 'catalog:' } : {}),
    ...(spec.react ? { react: 'catalog:', 'react-dom': 'catalog:', '@types/react': 'catalog:', '@types/react-dom': 'catalog:' } : {}),
    ...(spec.dev ?? {}),
  };

  const pkg = {
    name: spec.name,
    version: '0.1.0',
    description: spec.description,
    ...common,
    repository: { type: 'git', url: 'git+https://github.com/avonao/hypdriv.git', directory: `packages/${dir}` },
    keywords: ['nextjs', 'cloudflare', 'workers', 'edge', 'hypdriv', ...(spec.keywords ?? [])],
    ...(spec.bin ? { bin: spec.bin } : {}),
    exports: ordered,
    scripts: {
      build: 'tsdown',
      dev: 'tsdown --watch',
      typecheck: 'tsc --noEmit -p tsconfig.json',
      test: spec.workers ? 'vitest run && vitest run -c vitest.workers.config.ts' : 'vitest run',
    },
    ...(spec.deps ? { dependencies: spec.deps } : {}),
    ...(spec.peer ? { peerDependencies: spec.peer } : {}),
    ...(spec.peerMeta ? { peerDependenciesMeta: spec.peerMeta } : {}),
    devDependencies: devDeps,
  };
  if (spec.bin && spec.name === 'hypdriv') pkg.files = ['dist', 'bin', 'README.md', 'LICENSE'];
  write(join(pkgDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  const types = ['node', ...(spec.workers ? ['@cloudflare/workers-types', '@cloudflare/vitest-plugin/types'] : []), ...(spec.react ? ['react', 'react-dom'] : [])];
  write(
    join(pkgDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: { rootDir: 'src', types, ...(spec.platform === 'browser' ? {} : {}) },
        include: ['src/**/*.ts', 'src/**/*.tsx'],
      },
      null,
      2,
    )}\n`,
  );

  write(
    join(pkgDir, 'tsdown.config.ts'),
    `import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ${JSON.stringify(spec.entries, null, 4).replace(/\n/g, '\n  ').replace(/"/g, "'")},
  format: ['esm'],
  platform: '${spec.platform ?? 'neutral'}',
  target: 'es2023',
  external: [/^node:/, /^cloudflare:/],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  define: {
    __HYPDRIV_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
});
`,
  );

  const vitest = spec.workers
    ? `import { defineConfig } from 'vitest/config';

// Node project for pure logic; Workers project for files that need workerd APIs (Cache API, Durable Objects).
export default defineConfig({
  resolve: { conditions: ['source'] },
  test: {
    name: '${dir}',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['src/**/*.workers.test.ts'],
  },
});
`
    : `import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  test: {
    name: '${dir}',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
`;
  write(join(pkgDir, 'vitest.config.ts'), vitest);

  if (spec.workers) {
    write(
      join(pkgDir, 'vitest.workers.config.ts'),
      `import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs *.workers.test.ts inside workerd (Miniflare). Invoke with: pnpm vitest run -c vitest.workers.config.ts
export default defineConfig({
  resolve: { conditions: ['source'] },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    name: '${dir}-workers',
    include: ['src/**/*.workers.test.ts'],
  },
});
`,
    );
  }

  write(join(pkgDir, 'README.md'), `# ${spec.name}\n\n${spec.description}\n\nPart of [HypDriv](https://github.com/avonao/hypdriv). See the repository docs for guides.\n`);
  write(join(pkgDir, 'LICENSE'), '');
}
console.log('scaffolded', Object.keys(packages).length, 'packages');
