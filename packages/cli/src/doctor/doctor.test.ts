import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyManifest, type HypRoute } from '@hypdriv/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupProjects,
  fakeFetch,
  installed,
  memoryIO,
  openNextProject,
  response,
  tempProject,
  WRANGLER_JSONC,
} from '../__tests__/helpers';
import { canEvaluateCloudflareConfig } from '../cloudflare-config';
import { runCommand } from '../main';
import { allChecks } from './registry';
import type { CheckReport } from './types';

afterEach(cleanupProjects);

async function doctor(
  dir: string,
  args: string[] = [],
  env: Record<string, string> = {},
  fetchImpl?: typeof fetch,
) {
  const io = memoryIO(dir, { env, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const code = await runCommand('doctor', ['--json', ...args], io);
  const out = JSON.parse(io.out) as {
    summary: Record<string, number>;
    checks: CheckReport[];
    project: Record<string, unknown>;
  };
  const byId = Object.fromEntries(out.checks.map((c) => [c.id, c]));
  return { code, out, byId };
}

describe('check registry', () => {
  it('has at least 40 uniquely identified checks across all categories', () => {
    expect(allChecks.length).toBeGreaterThanOrEqual(40);
    expect(new Set(allChecks.map((c) => c.id)).size).toBe(allChecks.length);
    const categories = new Set(allChecks.map((c) => c.category));
    for (const c of [
      'environment',
      'nextjs',
      'opennext',
      'wrangler',
      'vercel',
      'workers-compat',
      'hypdriv',
      'size',
      'security',
      'purser',
      'deps',
    ])
      expect(categories.has(c as never)).toBe(true);
    for (const c of allChecks) expect(c.id).toMatch(/^[a-z-]+\.[a-z0-9-]+$/);
  });
});

describe.skipIf(!canEvaluateCloudflareConfig())('hypdriv doctor on a cf CLI project', () => {
  const config = `import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./hypdriv.worker.ts" with { type: "cf-worker" };
export default defineConfig({
  worker: {
    name: "shop",
    entrypoint,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    env: { ASSETS: bindings.assets() },
  },
});
`;

  it('reads cloudflare.config.ts instead of skipping the Wrangler checks', async () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'shop', type: 'module', dependencies: { next: '16.4.3' } }),
      'hypdriv.worker.ts': 'export default {};\n',
      'cloudflare.config.ts': config,
    });
    const { byId } = await doctor(p.dir, [
      '--only',
      'wrangler.config,wrangler.cloudflare-config,wrangler.main,wrangler.compat-flags,wrangler.assets',
    ]);
    expect(byId['wrangler.config']?.status).toBe('pass');
    expect(byId['wrangler.config']?.message).toContain('cf CLI format, evaluated');
    expect(byId['wrangler.cloudflare-config']?.message).toContain(
      'is the Worker configuration Hypdriv reads',
    );
    expect(byId['wrangler.main']?.status).toBe('pass');
    // No assets directory in this format: only the binding is checked.
    expect(byId['wrangler.assets']?.status).toBe('pass');
    expect(byId['wrangler.assets']?.message).toContain('(build output) → ASSETS');
  });

  it('reports a config that cannot be evaluated, and offers manual fixes only', async () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'shop', type: 'module', dependencies: { next: '16.4.3' } }),
      'cloudflare.config.ts':
        'import { defineConfig } from "cf/config";\nexport default defineConfig(() => { throw new Error("no account"); });\n',
    });
    const { byId } = await doctor(p.dir, ['--only', 'wrangler.config']);
    expect(byId['wrangler.config']?.status).toBe('fail');
    expect(byId['wrangler.config']?.message).toContain('no account');

    const bare = tempProject({
      'package.json': JSON.stringify({ name: 'shop', type: 'module', dependencies: { next: '16.4.3' } }),
      'cloudflare.config.ts':
        'import { defineConfig } from "cf/config";\nimport * as entrypoint from "./w.ts" with { type: "cf-worker" };\nexport default defineConfig({ worker: { name: "shop", entrypoint, compatibilityDate: "2026-09-01" } });\n',
      'w.ts': 'export default {};\n',
    });
    const main = await doctor(bare.dir, ['--only', 'wrangler.main']);
    expect(main.byId['wrangler.main']?.status).toBe('fail');
    expect(main.byId['wrangler.main']?.fix).toContain('cloudflare.config.ts manually');
    expect(main.byId['wrangler.main']?.fixable).toBe(false);
  });
});

describe('hypdriv doctor --wrangler', () => {
  const area = JSON.stringify({ name: 'area', type: 'module', dependencies: { next: '16.4.3' } });
  const generated = (assets: string) => `// generated
{
  "name": "web-site",
  "main": "../area/hypdriv.worker.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "${assets}", "binding": "ASSETS" },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "web-site" }],
}
`;

  it('checks a generated config that lives outside the project, resolving its paths against the config file', async () => {
    const p = tempProject({
      'area/package.json': area,
      'area/open-next.config.ts': 'export default {};\n',
      'infra/web.wrangler.jsonc': generated('../area/.open-next/assets'),
      'infra/other.wrangler.jsonc': generated('../elsewhere/assets'),
    });
    const only = [
      '--only',
      'wrangler.main,wrangler.assets,wrangler.self-reference',
      '--root',
      join(p.dir, 'area'),
    ];
    const ok = await doctor(p.dir, [...only, '--wrangler', 'infra/web.wrangler.jsonc']);
    expect(ok.byId['wrangler.main']?.status).toBe('pass');
    expect(ok.byId['wrangler.assets']?.status).toBe('pass');
    expect(ok.byId['wrangler.self-reference']?.status).toBe('pass');
    const wrong = await doctor(p.dir, [...only, '--wrangler', 'infra/other.wrangler.jsonc']);
    expect(wrong.byId['wrangler.assets']?.status).toBe('warn');
    // HYPDRIV_WRANGLER_CONFIG does the same as the flag; without either the project has no config.
    const viaEnv = await doctor(p.dir, only, {
      HYPDRIV_WRANGLER_CONFIG: join(p.dir, 'infra/web.wrangler.jsonc'),
    });
    expect(viaEnv.byId['wrangler.main']?.status).toBe('pass');
    const none = await doctor(p.dir, only);
    expect(none.byId['wrangler.main']?.status).toBe('skip');
  });
});

describe('hypdriv doctor', () => {
  it('reports the state of an OpenNext project before init', async () => {
    const p = openNextProject({
      'middleware.ts': 'export function middleware() {}\n',
      'app/edge/page.tsx': "export const runtime = 'edge';\nexport default function P() { return null; }\n",
      'lib/run.ts': "import { spawn } from 'child_process';\nexport const s = spawn;\n",
    });
    const { code, out, byId } = await doctor(p.dir);
    expect(code).toBe(1);
    expect(out.project).toMatchObject({
      next: '16.4.3',
      opennext: '1.20.14',
      packageManager: 'pnpm',
      platform: 'cloudflare',
    });
    expect(byId['env.node-version']?.status).toBe('pass');
    expect(byId['next.version']?.status).toBe('pass');
    expect(byId['next.with-hypdriv']).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('hypdriv init'),
    });
    expect(byId['next.middleware-deprecated']?.status).toBe('warn');
    expect(byId['next.edge-runtime']).toMatchObject({
      status: 'fail',
      details: [expect.stringContaining('app/edge/page.tsx:1')],
    });
    expect(byId['compat.node-apis']).toMatchObject({
      status: 'fail',
      details: [expect.stringContaining('lib/run.ts:1  child_process')],
    });
    expect(byId['opennext.installed']?.status).toBe('pass');
    expect(byId['opennext.next-support']?.status).toBe('pass');
    expect(byId['wrangler.main']).toMatchObject({ status: 'fail', fixable: true });
    expect(byId['wrangler.nodejs-compat']?.status).toBe('pass');
    expect(byId['wrangler.compatibility-date']?.status).toBe('pass');
    expect(byId['wrangler.observability']).toMatchObject({ status: 'warn', fixable: true });
    expect(byId['wrangler.self-reference']?.status).toBe('pass');
    expect(byId['hypdriv.worker-entry']?.status).toBe('fail');
    expect(byId['hypdriv.headers-file']).toMatchObject({ status: 'warn', fixable: true });
    expect(byId['vercel.config']).toMatchObject({ status: 'skip', platforms: ['vercel'] });
    expect(byId['deps.outdated']?.status).toBe('skip');
    // Checks for other frameworks (the Vite-host group) are left out of a Next.js report.
    expect(out.summary.total).toBe(
      allChecks.filter((c) => !c.frameworks || c.frameworks.includes('next')).length,
    );
  });

  it('maps per-environment queue consumers and flags orphaned queues and missing producers', async () => {
    const p = openNextProject({
      'hypdriv.config.ts': `export default {
  jobs: { queues: { jobs: { path: '/api/jobs/work', queues: ['*-jobs'] }, mail: { path: '/api/jobs/mail' } } },
  cloudflare: { bindings: { queues: { jobs: 'JOBS', mail: 'MAIL' } } },
};
`,
      'wrangler.jsonc': WRANGLER_JSONC.replace(
        '"services"',
        '"queues": { "producers": [{ "binding": "JOBS", "queue": "shop-staging-jobs" }], "consumers": [{ "queue": "shop-staging-jobs" }, { "queue": "shop-jobs-dlq" }] },\n  "services"',
      ),
    });
    const { byId } = await doctor(p.dir);
    expect(byId['wrangler.queues']).toMatchObject({ status: 'warn' });
    const details = (byId['wrangler.queues']?.details ?? []).join('\n');
    expect(details).toContain('consumer queue "shop-jobs-dlq" maps to no jobs.queues entry');
    expect(details).toContain('jobs.queues.mail has no queues.consumers entry');
    expect(details).toContain('no queues.producers entry binds MAIL');
    expect(details).not.toContain('jobs.queues.jobs has no');
  });

  it('passes the structural checks after init and syncs crons with --fix', async () => {
    const p = openNextProject({
      'hypdriv.config.ts':
        "export default { jobs: { cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } } } };\n",
    });
    await runCommand('init', ['--skip-doctor'], memoryIO(p.dir));
    // simulate a cron that drifted out of wrangler.jsonc
    p.write('wrangler.jsonc', p.read('wrangler.jsonc').replace('"0 9 * * 1"', '"0 10 * * 1"'));
    const before = await doctor(p.dir, [
      '--only',
      'wrangler.crons,wrangler.main,hypdriv.worker-entry,next.with-hypdriv,next.proxy-config,hypdriv.tsconfig-worker,hypdriv.headers-file',
    ]);
    expect(before.byId['wrangler.crons']).toMatchObject({ status: 'fail', fixable: true });
    expect(before.byId['wrangler.main']?.status).toBe('pass');
    expect(before.byId['hypdriv.worker-entry']?.status).toBe('pass');
    expect(before.byId['next.with-hypdriv']?.status).toBe('pass');
    expect(before.byId['next.proxy-config']?.status).toBe('pass');
    expect(before.byId['hypdriv.tsconfig-worker']?.status).toBe('pass');
    expect(before.byId['hypdriv.headers-file']?.status).toBe('pass');
    expect(before.code).toBe(1);
    const fixed = await doctor(p.dir, ['--fix', '--only', 'wrangler.crons']);
    expect(fixed.byId['wrangler.crons']).toMatchObject({ status: 'pass', fixed: true });
    expect(fixed.code).toBe(0);
    expect(p.read('wrangler.jsonc')).toContain('"0 9 * * 1"');
  });

  it('fails a re-exported proxy config and an Edge proxy runtime', async () => {
    const p = openNextProject({
      'proxy.ts':
        "import { createProxy, matcher } from 'hypdriv/proxy';\nexport default createProxy({});\nexport { matcher as config };\n",
    });
    const { byId } = await doctor(p.dir, ['--only', 'next.proxy-config']);
    expect(byId['next.proxy-config']).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('export const config = {'),
    });
    p.write('proxy.ts', 'export default function p() {}\nexport const config = buildConfig();\n');
    expect((await doctor(p.dir, ['--only', 'next.proxy-config'])).byId['next.proxy-config']?.status).toBe(
      'fail',
    );
  });

  it('exits 1 in --ci mode on failures and prints compact text', async () => {
    const p = openNextProject();
    const io = memoryIO(p.dir);
    const code = await runCommand('doctor', ['--ci'], io);
    expect(code).toBe(1);
    expect(io.out).toContain('✗');
    expect(io.out).not.toContain('✓ Node.js version');
    expect(io.out).toMatch(/\d+ checks: /);
  });

  it('applies the safe fixes for headers, scripts and .dev.vars.example', async () => {
    const p = openNextProject();
    const { byId } = await doctor(p.dir, [
      '--fix',
      '--only',
      'hypdriv.headers-file,hypdriv.scripts,hypdriv.dev-vars-example,wrangler.observability',
    ]);
    expect(byId['hypdriv.headers-file']?.fixed).toBe(true);
    expect(byId['hypdriv.scripts']?.fixed).toBe(true);
    expect(byId['hypdriv.dev-vars-example']?.fixed).toBe(true);
    expect(byId['wrangler.observability']?.fixed).toBe(true);
    expect(p.read('public/_headers')).toContain('immutable');
    expect(JSON.parse(p.read('package.json')).scripts['hypdriv:doctor']).toBe('hypdriv doctor');
    expect(p.read('wrangler.jsonc')).toContain('"observability": { "enabled": true }');
  });

  it('checks dependency freshness through the registry (mocked)', async () => {
    const p = openNextProject();
    const { fetch } = fakeFetch((url) => {
      const latest: Record<string, string> = {
        next: '17.0.0',
        react: '19.3.1',
        '@opennextjs/cloudflare': '1.21.0',
        wrangler: '4.156.0',
      };
      const name = decodeURIComponent(url.split('/').pop()!.replace(/^@/, '@'));
      const key = Object.keys(latest).find((k) =>
        url.endsWith(k.startsWith('@') ? `@${encodeURIComponent(k.slice(1))}` : k),
      );
      return response(
        JSON.stringify({
          name,
          'dist-tags': { latest: key ? latest[key] : '1.0.0' },
          versions: key ? { [latest[key]!]: {} } : {},
        }),
      );
    });
    const { byId } = await doctor(p.dir, ['--only', 'deps.outdated'], { HYPDRIV_OFFLINE: '0' }, fetch);
    expect(byId['deps.outdated']).toMatchObject({
      status: 'warn',
      details: expect.arrayContaining(['next: 16.4.3 → 17.0.0', '@opennextjs/cloudflare: ^1.20.0 → 1.21.0']),
    });
  });

  it('runs Vercel checks and skips Cloudflare-only checks on Vercel', async () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '16.4.3', hypdriv: '^0.1.0' } }),
      ...installed('next', '16.4.3'),
      ...installed('hypdriv', '0.1.0'),
      'vercel.json': JSON.stringify({
        regions: ['fra1'],
        crons: [{ path: '/api/jobs/digest', schedule: '0 8 * * 1' }],
      }),
      'hypdriv.config.ts':
        "export default { jobs: { cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } } } };\n",
      'app/api/jobs/digest/route.ts': 'export const POST = () => new Response(null);\n',
      'proxy.ts':
        "import { createProxy } from 'hypdriv/proxy';\nexport default createProxy({});\nexport const config = { matcher: ['/((?!_next).*)'], runtime: 'edge' };\n",
      'next.config.ts': "import { withHypDriv } from 'hypdriv/config';\nexport default withHypDriv({});\n",
    });
    const { byId, out } = await doctor(p.dir);
    expect(out.project.platform).toBe('vercel');
    expect(byId['wrangler.main']?.status).toBe('skip');
    expect(byId['opennext.installed']?.status).toBe('skip');
    expect(byId['hypdriv.worker-entry']?.status).toBe('skip');
    expect(byId['vercel.config']?.status).toBe('pass');
    expect(byId['vercel.crons']).toMatchObject({
      status: 'fail',
      fixable: true,
      details: ['/api/jobs/digest: schedule "0 8 * * 1" ≠ "0 9 * * 1"'],
    });
    expect(byId['vercel.cron-routes']).toMatchObject({
      status: 'warn',
      details: [expect.stringContaining('does not export GET')],
    });
    expect(byId['vercel.cron-secret']?.status).toBe('warn');
    expect(byId['vercel.regions']?.status).toBe('warn');
    expect(byId['vercel.proxy-runtime']?.status).toBe('fail');
    expect(byId['vercel.function-size']?.status).toBe('skip');
    // Vercel owns deployment ids and skew protection; cron jobs authenticate with CRON_SECRET there.
    expect(byId['next.deployment-id']).toMatchObject({
      status: 'pass',
      message: expect.stringContaining('VERCEL_DEPLOYMENT_ID'),
    });
    expect(byId['security.internal-secret']?.status).toBe('skip');
    const fixed = await doctor(p.dir, ['--fix', '--only', 'vercel.crons'], { CRON_SECRET: 'x'.repeat(32) });
    expect(fixed.byId['vercel.crons']?.fixed).toBe(true);
    expect(JSON.parse(p.read('vercel.json')).crons).toEqual([
      { path: '/api/jobs/digest', schedule: '0 9 * * 1' },
    ]);
    expect(
      (await doctor(p.dir, ['--only', 'vercel.cron-secret'], { CRON_SECRET: 'secret' })).byId[
        'vercel.cron-secret'
      ]?.status,
    ).toBe('pass');
  });

  it('measures Vercel function bundles from .vercel/output', async () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '16.4.3' } }),
      'vercel.json': '{}',
      '.vercel/output/config.json': '{"version":3}',
      '.vercel/output/functions/index.func/.vc-config.json': JSON.stringify({
        runtime: 'nodejs22.x',
        handler: 'index.js',
        regions: ['iad1'],
        filePathMap: { 'node_modules/big/index.js': 'node_modules/big/index.js' },
      }),
      '.vercel/output/functions/index.func/index.js': 'x'.repeat(1000),
      'node_modules/big/index.js': 'y'.repeat(5000),
    });
    const { byId } = await doctor(p.dir, ['--only', 'vercel.function-size']);
    expect(byId['vercel.function-size']).toMatchObject({
      status: 'pass',
      message: expect.stringContaining('1 function(s)'),
    });
  });
});

describe('check isolation', () => {
  it('turns a crashing check into a failed report', async () => {
    const { runDoctor } = await import('./run');
    const p = openNextProject();
    mkdirSync(join(p.dir, 'x'), { recursive: true });
    writeFileSync(join(p.dir, 'x', 'y'), '');
    const run = await runDoctor(
      [
        {
          id: 'test.crash',
          title: 'crash',
          category: 'environment',
          severity: 'error',
          run: () => {
            throw new Error('boom');
          },
        },
      ],
      {} as never,
    );
    expect(run.reports[0]).toMatchObject({ status: 'fail', message: 'check crashed: boom' });
    expect(run.exitCode).toBe(1);
  });
});

describe('wrangler.self-reference on sites that never revalidate', () => {
  const wrangler = `{ "name": "site", "main": "hypdriv.worker.ts", "assets": { "directory": ".open-next/assets", "binding": "ASSETS" } }`;
  const only = ['--only', 'wrangler.self-reference'];

  it('is informational without ISR routes and revalidation calls, and warns once the sources revalidate', async () => {
    const quiet = tempProject({
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '16.4.3' } }),
      'wrangler.jsonc': wrangler,
      'src/app/page.tsx': 'export default function Page() { return null; }\n',
      '.hypdriv/manifest.json': JSON.stringify(
        emptyManifest({ routes: [{ id: 'app:/', classification: 'static' } as HypRoute] }),
      ),
    });
    const quietCheck = (await doctor(quiet.dir, only)).byId['wrangler.self-reference'];
    expect(quietCheck?.status).toBe('pass');
    expect(quietCheck?.message).toContain('not needed here');
    const revalidating = tempProject({
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '16.4.3' } }),
      'wrangler.jsonc': wrangler,
      'src/app/actions.ts':
        "'use server';\nimport { revalidateTag } from 'next/cache';\nexport const f = () => revalidateTag('x');\n",
    });
    expect((await doctor(revalidating.dir, only)).byId['wrangler.self-reference']?.status).toBe('warn');
  });
});

describe('wrangler environments', () => {
  const wrangler = `{
    "name": "site", "main": "hypdriv.worker.ts", "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
    "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "site" }],
    "kv_namespaces": [{ "binding": "HYPDRIV_KV", "id": "a" }],
    "env": {
      "good": { "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "site-good" }], "kv_namespaces": [{ "binding": "HYPDRIV_KV", "id": "b" }] },
      "bad": {}
    }
  }`;
  const files = {
    'package.json': JSON.stringify({ name: 'site', dependencies: { next: '16.4.3' } }),
    'wrangler.jsonc': wrangler,
  };

  it('warns when an environment loses bindings the top level declares', async () => {
    const p = tempProject(files);
    const check = (await doctor(p.dir, ['--only', 'wrangler.env-bindings'])).byId['wrangler.env-bindings'];
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('env.bad lacks services, kv_namespaces');
    expect(check?.message).not.toContain('env.good');
  });

  it('checks one environment as Wrangler resolves it with --env', async () => {
    const p = tempProject(files);
    const ids = ['--only', 'wrangler.config,wrangler.env-bindings,wrangler.self-reference'];
    const good = await doctor(p.dir, [...ids, '--env', 'good']);
    expect(good.byId['wrangler.config']?.message).toContain('environment "good" (name site-good)');
    expect(good.byId['wrangler.env-bindings']?.status).toBe('pass');
    expect(good.byId['wrangler.self-reference']?.status).not.toBe('fail');
    const bad = await doctor(p.dir, [...ids, '--env', 'bad']);
    expect(bad.byId['wrangler.self-reference']?.status).toBe('warn');
    const missing = await doctor(p.dir, [...ids, '--env', 'nope']);
    expect(missing.byId['wrangler.config']?.status).toBe('fail');
    expect(missing.byId['wrangler.config']?.message).toContain('no environment "nope"');
  });
});

describe('vitals dashboard checks', () => {
  const cloudflare = (dashboard: string, extra: Record<string, string> = {}) =>
    tempProject({
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '16.4.3' } }),
      'wrangler.jsonc': WRANGLER_JSONC,
      'hypdriv.config.ts': `export default { observe: { vitals: { ${dashboard} } } };\n`,
      ...extra,
    });
  const ids = ['--only', 'security.dashboard-token,security.dashboard-source'];

  it('stays out of the way while the dashboard is off', async () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '16.4.3' } }),
      'wrangler.jsonc': WRANGLER_JSONC,
      'hypdriv.config.ts': 'export default { observe: { vitals: true } };\n',
    });
    const { byId } = await doctor(p.dir, ids);
    expect(byId['security.dashboard-token']?.status).toBe('skip');
    expect(byId['security.dashboard-source']?.status).toBe('skip');
  });

  it('warns that a missing access token hides the dashboard, and passes once it is set', async () => {
    const p = cloudflare('dashboard: true');
    const missing = (await doctor(p.dir, ids)).byId['security.dashboard-token'];
    expect(missing?.status).toBe('warn');
    expect(missing?.message).toContain('HYPDRIV_DASH_TOKEN');
    expect(missing?.message).toContain('wrangler secret put HYPDRIV_DASH_TOKEN');
    const set = (await doctor(p.dir, ids, { HYPDRIV_DASH_TOKEN: 'x'.repeat(40) })).byId[
      'security.dashboard-token'
    ];
    expect(set?.status).toBe('pass');
  });

  it('flags a short token kept in .dev.vars', async () => {
    const p = cloudflare('dashboard: true', {
      '.dev.vars': 'HYPDRIV_DASH_TOKEN=short-token\n',
      '.gitignore': '.dev.vars\n',
    });
    const check = (await doctor(p.dir, ids)).byId['security.dashboard-token'];
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('at least 24');
  });

  it('explains what durable numbers need, and catches a sink that never fills the dataset', async () => {
    const p = cloudflare("dashboard: { dataset: 'shop_vitals' }");
    const partial = (await doctor(p.dir, ids)).byId['security.dashboard-source'];
    expect(partial).toMatchObject({ status: 'pass', informational: true });
    expect(partial?.message).toContain('HYPDRIV_ANALYTICS_ACCOUNT_ID');
    expect(partial?.message).toContain('HYPDRIV_ANALYTICS_API_TOKEN');
    expect(partial?.message).not.toContain('HYPDRIV_ANALYTICS_DATASET');
    const env = { HYPDRIV_ANALYTICS_ACCOUNT_ID: 'acc', HYPDRIV_ANALYTICS_API_TOKEN: 'tok' };
    const wrongSink = (await doctor(p.dir, ids, env)).byId['security.dashboard-source'];
    expect(wrongSink?.status).toBe('warn');
    expect(wrongSink?.message).toContain("sink is not 'analytics-engine'");
    const good = cloudflare("sink: 'analytics-engine', dashboard: { dataset: 'shop_vitals' }");
    expect((await doctor(good.dir, ids, env)).byId['security.dashboard-source']?.status).toBe('pass');
  });

  it('says Analytics Engine is a Cloudflare feature on other platforms', async () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '16.4.3' } }),
      'vercel.json': '{}',
      'hypdriv.config.ts': 'export default { observe: { vitals: { dashboard: true } } };\n',
    });
    const check = (await doctor(p.dir, ids)).byId['security.dashboard-source'];
    expect(check).toMatchObject({ status: 'pass', informational: true });
    expect(check?.message).toContain('Speed Insights');
  });
});
