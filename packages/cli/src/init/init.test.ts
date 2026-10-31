import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, installed, memoryIO, openNextProject, tempProject } from '../__tests__/helpers';
import { runCommand } from '../main';
import { parseJsonc } from '../wrangler-config';
import { insertImport, scanExpressionEnd, wrapNextConfig } from './next-config';
import { editPackageJson, ensureHeadersRule } from './package-json';
import { addTsconfigExclude } from './tsconfig';
import { editWranglerJsonc } from './wrangler';

afterEach(cleanupProjects);

describe('wrapNextConfig', () => {
  it('wraps an identifier export and adds the import after the existing imports', () => {
    const src =
      "import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {\n  reactStrictMode: true,\n};\n\nexport default nextConfig;\n";
    const r = wrapNextConfig(src);
    expect(r).toMatchObject({ changed: true, shape: 'identifier' });
    expect(r.content).toBe(
      "import type { NextConfig } from 'next';\nimport { withHypDriv } from 'hypdriv/config';\n\nconst nextConfig: NextConfig = {\n  reactStrictMode: true,\n};\n\nexport default withHypDriv(nextConfig);\n",
    );
    expect(wrapNextConfig(r.content)).toMatchObject({
      changed: false,
      reason: 'already wrapped in withHypDriv()',
    });
  });

  it('wraps an object literal spanning lines with nested braces, strings and comments', () => {
    const src = `// next config\nexport default {\n  images: { remotePatterns: [{ hostname: "a.com" }] }, // }\n  headers: async () => [{ source: "/(.*)", headers: [] }],\n  env: { X: \`\${"}"}\` },\n};\n\nimport { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";\ninitOpenNextCloudflareForDev();\n`;
    const r = wrapNextConfig(src);
    expect(r.shape).toBe('object');
    expect(r.content).toContain('export default withHypDriv({\n  images:');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source text under test
    expect(r.content).toContain('  env: { X: `${"}"}` },\n});\n');
    expect(r.content.startsWith('// next config\nimport { withHypDriv } from "hypdriv/config";\n')).toBe(
      true,
    );
    expect(r.content).toContain('initOpenNextCloudflareForDev();');
  });

  it('wraps module.exports in CommonJS configs and function exports', () => {
    const cjs = wrapNextConfig(
      "/** @type {import('next').NextConfig} */\nconst config = { output: 'standalone' }\nmodule.exports = config\n",
    );
    expect(cjs.content).toBe(
      "/** @type {import('next').NextConfig} */\nconst { withHypDriv } = require('hypdriv/config')\nconst config = { output: 'standalone' }\nmodule.exports = withHypDriv(config)\n",
    );
    const fn = wrapNextConfig(
      "export default async function config(phase) {\n  return { reactStrictMode: phase !== 'x' };\n}\n",
    );
    expect(fn.shape).toBe('function');
    expect(fn.content).toContain(
      "export default withHypDriv(async function config(phase) {\n  return { reactStrictMode: phase !== 'x' };\n})\n",
    );
    expect(wrapNextConfig('const x = 1;')).toMatchObject({ changed: false });
  });

  it('finds expression ends across continuation lines', () => {
    const src = 'export default compose(a)\n  .with(b)\n\nconst y = 2;';
    expect(src.slice(15, scanExpressionEnd(src, 15))).toBe('compose(a)\n  .with(b)');
    expect(insertImport("'use client';\nconst a = 1;", "import x from 'x';", 'esm')).toBe(
      "'use client';\nimport x from 'x';\nconst a = 1;",
    );
  });
});

describe('wrangler and package.json edits', () => {
  it('replaces main and adds observability and crons while keeping comments', () => {
    const src =
      '{\n  // worker\n  "name": "shop",\n  "main": ".open-next/worker.js", // default\n  "compatibility_date": "2026-09-01"\n}\n';
    const r = editWranglerJsonc(src, { main: 'hypdriv.worker.ts', crons: ['0 9 * * 1'] });
    expect(r.changes).toEqual([
      'main: ".open-next/worker.js" → "hypdriv.worker.ts"',
      'observability.enabled: true added',
      'triggers.crons: added "0 9 * * 1"',
    ]);
    expect(r.content).toContain('// worker');
    expect(r.content).toContain('"main": "hypdriv.worker.ts", // default');
    const parsed = parseJsonc(r.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      main: 'hypdriv.worker.ts',
      observability: { enabled: true },
      triggers: { crons: ['0 9 * * 1'] },
    });
    expect(editWranglerJsonc(r.content, { main: 'hypdriv.worker.ts', crons: ['0 9 * * 1'] }).changes).toEqual(
      [],
    );
    const merged = editWranglerJsonc('{ "name": "x", "triggers": { "crons": ["1 * * * *"] } }', {
      main: 'hypdriv.worker.ts',
      observability: false,
      crons: ['0 9 * * 1'],
    });
    expect(parseJsonc(merged.content)).toMatchObject({
      main: 'hypdriv.worker.ts',
      triggers: { crons: ['1 * * * *', '0 9 * * 1'] },
    });
    const empty = editWranglerJsonc('{}', { main: 'hypdriv.worker.ts' });
    expect(parseJsonc(empty.content)).toEqual({
      main: 'hypdriv.worker.ts',
      observability: { enabled: true },
    });
  });

  it('adds scripts and the hypdriv dependency once', () => {
    const src =
      '{\n    "name": "x",\n    "scripts": { "dev": "next dev" },\n    "dependencies": { "next": "16.4.3" }\n}\n';
    const r = editPackageJson(src, {
      scripts: { 'hypdriv:doctor': 'hypdriv doctor', dev: 'other' },
      dependency: { name: 'hypdriv', range: '^0.1.0' },
    });
    expect(r.changes).toEqual(['script "hypdriv:doctor"', 'dependency "hypdriv": "^0.1.0"']);
    expect(r.content).toContain('\n    "name": "x"');
    expect(JSON.parse(r.content)).toMatchObject({
      scripts: { dev: 'next dev', 'hypdriv:doctor': 'hypdriv doctor' },
      dependencies: { hypdriv: '^0.1.0', next: '16.4.3' },
    });
    expect(
      editPackageJson(r.content, {
        scripts: { 'hypdriv:doctor': 'x' },
        dependency: { name: 'hypdriv', range: '^0.1.0' },
      }).changes,
    ).toEqual([]);
  });

  it('does not add a script whose command the project already has under another name', () => {
    const src = JSON.stringify({
      name: 'x',
      scripts: { 'cf:typegen': 'wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts' },
    });
    const r = editPackageJson(src, {
      scripts: {
        'cf-typegen': 'wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts',
        'hypdriv:doctor': 'hypdriv doctor',
      },
    });
    expect(r.changes).toEqual(['script "hypdriv:doctor"']);
    expect(JSON.parse(r.content).scripts).not.toHaveProperty('cf-typegen');
  });

  it('ensures the immutable _headers rule and the tsconfig exclude', () => {
    const rule = '/_next/static/*\n  Cache-Control: public,max-age=31536000,immutable\n';
    expect(ensureHeadersRule(null, rule)).toEqual({ content: rule, changed: true });
    expect(ensureHeadersRule(`/x\n  X-Y: z\n`, rule).content).toBe(`/x\n  X-Y: z\n\n${rule}`);
    expect(ensureHeadersRule(rule, rule).changed).toBe(false);
    const ts = addTsconfigExclude(
      '{\n  // c\n  "include": ["**/*.ts"],\n  "exclude": [\n    "node_modules"\n  ]\n}\n',
      'hypdriv.worker.ts',
    );
    expect(ts.content).toBe(
      '{\n  // c\n  "include": ["**/*.ts"],\n  "exclude": [\n    "node_modules",\n    "hypdriv.worker.ts"\n  ]\n}\n',
    );
    expect(addTsconfigExclude(ts.content, 'hypdriv.worker.ts').changed).toBe(false);
    expect(parseJsonc(addTsconfigExclude('{ "include": ["a"] }', 'hypdriv.worker.ts').content)).toEqual({
      include: ['a'],
      exclude: ['node_modules', '.open-next', 'hypdriv.worker.ts'],
    });
  });
});

describe('hypdriv init', () => {
  it('prints a dry-run plan without writing', async () => {
    const p = openNextProject();
    const io = memoryIO(p.dir);
    const code = await runCommand('init', ['--dry-run', '--json'], io);
    expect(code).toBe(0);
    const out = JSON.parse(io.out);
    expect(out.platform).toBe('cloudflare');
    expect(out.dryRun).toBe(true);
    const byPath = Object.fromEntries(
      out.plan.map((i: { path: string; action: string }) => [i.path, i.action]),
    );
    expect(byPath).toMatchObject({
      'hypdriv.config.ts': 'create',
      'next.config.ts': 'modify',
      'hypdriv.worker.ts': 'create',
      'tsconfig.json': 'modify',
      'wrangler.jsonc': 'modify',
      'proxy.ts': 'create',
      'public/_headers': 'create',
      '.dev.vars.example': 'create',
      'instrumentation.ts': 'create',
      'package.json': 'modify',
      '.gitignore': 'modify',
    });
    expect(out.written).toEqual([]);
    expect(existsSync(join(p.dir, 'hypdriv.config.ts'))).toBe(false);
  });

  it('applies the plan with backups, mirrors examples/basic and is idempotent', async () => {
    const p = openNextProject();
    const io = memoryIO(p.dir);
    expect(await runCommand('init', ['--skip-doctor'], io)).toBe(0);
    expect(io.out).toContain('Wrote 11 file(s)');
    for (const backup of ['next.config.ts', 'wrangler.jsonc', 'package.json', 'tsconfig.json'])
      expect(existsSync(join(p.dir, `${backup}.hypdriv.bak`))).toBe(true);
    expect(existsSync(join(p.dir, '.gitignore.hypdriv.bak'))).toBe(false);
    expect(p.read('.gitignore')).toBe('node_modules\n.dev.vars\n\n# Hypdriv\n.hypdriv/\n*.hypdriv.bak\n');
    expect(p.read('next.config.ts.hypdriv.bak')).not.toContain('withHypDriv');
    expect(p.read('next.config.ts')).toContain("import { withHypDriv } from 'hypdriv/config';");
    expect(p.read('next.config.ts')).toContain('export default withHypDriv(nextConfig);');
    expect(p.read('next.config.ts')).toContain('initOpenNextCloudflareForDev();');
    const wrangler = p.read('wrangler.jsonc');
    expect(wrangler).toContain('// The Worker name');
    expect(wrangler).toContain('"main": "hypdriv.worker.ts", // OpenNext\'s default entry');
    expect(p.read('hypdriv.worker.ts')).toContain("import { createWorker } from 'hypdriv/cloudflare';");
    expect(p.read('hypdriv.worker.ts')).toContain(
      "export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from 'hypdriv/durable-objects';",
    );
    const proxy = p.read('proxy.ts');
    expect(proxy).toContain("import { createProxy } from 'hypdriv/proxy';");
    expect(proxy).toContain('export default createProxy(hypdrivConfig);');
    expect(proxy).toContain("'/((?!_next/static|_next/image|favicon\\\\.ico|robots\\\\.txt|sitemap\\\\.xml|");
    expect(proxy).toContain("'/_hypdriv/:path*',");
    expect(proxy).not.toContain('matcher as config');
    expect(p.read('instrumentation.ts')).toContain('createInstrumentation({ config })');
    expect(p.read('hypdriv.config.ts')).toContain("site: { name: 'acme-shop'");
    expect(p.read('tsconfig.json')).toContain('"hypdriv.worker.ts"');
    expect(JSON.parse(p.read('package.json')).dependencies.hypdriv).toMatch(/^\^/);
    expect(JSON.parse(p.read('package.json')).scripts['hypdriv:audit']).toBe(
      'hypdriv audit all --url http://localhost:8787',
    );

    const again = memoryIO(p.dir);
    expect(await runCommand('init', ['--json', '--skip-doctor'], again)).toBe(0);
    const second = JSON.parse(again.out);
    expect(second.written).toEqual([]);
    expect(second.plan.every((i: { action: string }) => i.action === 'skip')).toBe(true);
  });

  it('prints composition instructions for an existing proxy and handles --no-proxy', async () => {
    const p = openNextProject({ 'proxy.ts': 'export default function proxy() {}\n' });
    const io = memoryIO(p.dir);
    await runCommand('init', ['--dry-run', '--json'], io);
    const plan = JSON.parse(io.out).plan as Array<{ path: string; action: string; hint?: string }>;
    const proxy = plan.find((i) => i.path === 'proxy.ts');
    expect(proxy?.action).toBe('manual');
    expect(proxy?.hint).toContain('createProxy(hypdrivConfig)');
    const noProxy = openNextProject();
    const io2 = memoryIO(noProxy.dir);
    await runCommand('init', ['--no-proxy', '--skip-doctor'], io2);
    expect(existsSync(join(noProxy.dir, 'proxy.ts'))).toBe(false);
  });

  it('targets Vercel: no Worker files, crons in vercel.json, .env.example', async () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '16.4.3' } }, null, 2),
      ...installed('next', '16.4.3'),
      'next.config.ts': 'export default { reactStrictMode: true };\n',
      'hypdriv.config.ts':
        "export default { jobs: { cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } } } };\n",
      'app/layout.tsx': 'export default function L({ children }) { return children; }\n',
    });
    const io = memoryIO(p.dir);
    expect(await runCommand('init', ['--platform', 'vercel', '--skip-doctor', '--json'], io)).toBe(0);
    const out = JSON.parse(io.out);
    expect(out.platform).toBe('vercel');
    expect(out.written).toEqual(
      expect.arrayContaining([
        'vercel.json',
        'next.config.ts',
        'proxy.ts',
        '.env.example',
        'instrumentation.ts',
        'package.json',
      ]),
    );
    expect(existsSync(join(p.dir, 'hypdriv.worker.ts'))).toBe(false);
    expect(existsSync(join(p.dir, 'wrangler.jsonc'))).toBe(false);
    expect(existsSync(join(p.dir, 'public/_headers'))).toBe(false);
    expect(JSON.parse(p.read('vercel.json'))).toEqual({
      $schema: 'https://openapi.vercel.sh/vercel.json',
      crons: [{ path: '/api/jobs/digest', schedule: '0 9 * * 1' }],
    });
    expect(p.read('.env.example')).toContain('\nCRON_SECRET=');
    expect(JSON.parse(p.read('package.json')).scripts).toEqual({
      'hypdriv:doctor': 'hypdriv doctor',
      'hypdriv:analyze': 'hypdriv analyze',
      'hypdriv:audit': 'hypdriv audit all --url http://localhost:3000',
    });
    const again = memoryIO(p.dir);
    await runCommand('init', ['--platform', 'vercel', '--skip-doctor', '--json'], again);
    expect(JSON.parse(again.out).written).toEqual([]);
  });
});
