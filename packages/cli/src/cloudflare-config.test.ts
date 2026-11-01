import { afterAll, describe, expect, it } from 'vitest';
import { cleanupProjects, tempProject } from './__tests__/helpers';
import {
  canEvaluateCloudflareConfig,
  cloudflareConfigToWrangler,
  evaluateCloudflareConfig,
  findCloudflareConfig,
  isCloudflareConfigFile,
  readCloudflareConfig,
} from './cloudflare-config';

afterAll(cleanupProjects);

const ENTRY =
  'export default { fetch() { throw new Error("the Worker entry must never run"); } };\nexport class Counter {}\n';

const FULL = `import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig(({ mode }) => ({
  accountId: "0123456789abcdef",
  worker: {
    name: mode === "staging" ? "orders-staging" : "orders-api",
    entrypoint,
    compatibilityDate: "2026-08-24",
    compatibilityFlags: ["nodejs_compat"],
    observability: { enabled: true, headSamplingRate: 0.1, logs: { enabled: true } },
    assets: { runWorkerFirst: ["/*", "!/assets/*"], notFoundHandling: "single-page-application" },
    env: {
      ENVIRONMENT: bindings.text(mode === "staging" ? "staging" : "production"),
      LIMITS: bindings.json({ burst: 5 }),
      TOKEN: bindings.secret(),
      ASSETS: bindings.assets(),
      DB: bindings.d1({ name: "orders-db", id: "db-1" }),
      JOBS: bindings.queue({ name: "orders-jobs" }),
      CACHE: bindings.kv({ title: "cache", id: "kv-1" }),
      FILES: bindings.r2({ name: "orders-files" }),
      COUNTERS: bindings.durableObject({ worker: "orders-api", exportName: "Counter" }),
      REMOTE: bindings.durableObject({ worker: "billing", exportName: "Ledger" }),
      BILLING: bindings.worker({ worker: "billing", exportName: "Admin" }),
      AI: bindings.ai(),
      METRICS: bindings.analyticsEngine({ dataset: "orders_events" }),
    },
    exports: {
      default: exports.worker({}),
      Counter: exports.durableObject({ storage: "sqlite" }),
      Legacy: exports.durableObject({ storage: "legacy-kv" }),
      Gone: exports.durableObject({ state: "deleted" }),
    },
    triggers: [
      triggers.scheduled({ schedule: "0 * * * *" }),
      triggers.queue({ name: "orders-jobs", maxBatchSize: 10 }),
      triggers.fetch({ pattern: "api.example.com/*", zone: "example.com" }),
    ],
  },
}));
`;

function project(files: Record<string, string>) {
  return tempProject({ 'package.json': '{"type":"module"}', 'src/index.ts': ENTRY, ...files });
}

const evaluable = canEvaluateCloudflareConfig();

describe('cloudflare.config.* discovery', () => {
  it('finds the config file by name, TypeScript first', () => {
    const p = project({
      'cloudflare.config.mjs': 'export default {};',
      'cloudflare.config.ts': 'export default {};',
    });
    expect(findCloudflareConfig(p.dir)).toBe(`${p.dir}/cloudflare.config.ts`);
    expect(findCloudflareConfig(project({}).dir)).toBeNull();
  });

  it('recognises the file names', () => {
    expect(isCloudflareConfigFile('/app/cloudflare.config.ts')).toBe(true);
    expect(isCloudflareConfigFile('cloudflare.config.mjs')).toBe(true);
    expect(isCloudflareConfigFile('/app/wrangler.jsonc')).toBe(false);
    expect(isCloudflareConfigFile('/app/mycloudflare.config.ts')).toBe(false);
  });
});

describe.skipIf(!evaluable)('evaluating cloudflare.config.ts', () => {
  it('reads a function-form config without running the Worker entry', () => {
    const p = project({ 'cloudflare.config.ts': FULL });
    const config = readCloudflareConfig(`${p.dir}/cloudflare.config.ts`);
    expect(config.name).toBe('orders-api');
    expect(config.main).toBe('./src/index.ts');
    expect(config.compatibility_date).toBe('2026-08-24');
    expect(config.compatibility_flags).toEqual(['nodejs_compat']);
    expect(config.observability).toMatchObject({ enabled: true, logs: { enabled: true } });
    expect(config.assets).toEqual({ binding: 'ASSETS', run_worker_first: ['/*', '!/assets/*'] });
    expect(config.vars).toEqual({ ENVIRONMENT: 'production', LIMITS: { burst: 5 } });
    expect(config.d1_databases).toEqual([{ binding: 'DB', database_name: 'orders-db', database_id: 'db-1' }]);
    expect(config.kv_namespaces).toEqual([{ binding: 'CACHE', id: 'kv-1', title: 'cache' }]);
    expect(config.r2_buckets).toEqual([{ binding: 'FILES', bucket_name: 'orders-files' }]);
    expect(config.queues.producers).toEqual([{ binding: 'JOBS', queue: 'orders-jobs' }]);
    expect(config.queues.consumers).toEqual([{ queue: 'orders-jobs' }]);
    expect(config.services).toEqual([{ binding: 'BILLING', service: 'billing', entrypoint: 'Admin' }]);
    expect(config.durable_objects.bindings).toEqual([
      { name: 'COUNTERS', class_name: 'Counter' },
      { name: 'REMOTE', class_name: 'Ledger', script_name: 'billing' },
    ]);
    expect(config.ai).toEqual({ binding: 'AI' });
    expect(config.analytics_engine_datasets).toEqual([{ binding: 'METRICS', dataset: 'orders_events' }]);
    expect(config.triggers).toEqual({ crons: ['0 * * * *'] });
    expect(config.migrations).toEqual([
      {
        tag: 'cloudflare.config.ts',
        new_classes: ['Legacy'],
        new_sqlite_classes: ['Counter'],
        deleted_classes: ['Gone'],
      },
    ]);
  });

  it('passes the mode to a function-form config', () => {
    const p = project({ 'cloudflare.config.ts': FULL });
    const file = `${p.dir}/cloudflare.config.ts`;
    expect(readCloudflareConfig(file, { mode: 'staging' }).name).toBe('orders-staging');
    expect(readCloudflareConfig(file, { mode: 'staging' }).vars.ENVIRONMENT).toBe('staging');
  });

  it('accepts an object, a promise and a string entry point', () => {
    const object = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
export default defineConfig({ worker: { name: "plain", entrypoint: "./src/index.ts", compatibilityDate: "2026-01-01" } });`,
    });
    expect(readCloudflareConfig(`${object.dir}/cloudflare.config.ts`)).toMatchObject({
      name: 'plain',
      main: './src/index.ts',
    });
    const promised = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
export default defineConfig(Promise.resolve({ worker: { name: "later", compatibilityDate: "2026-01-01" } }));`,
    });
    expect(readCloudflareConfig(`${promised.dir}/cloudflare.config.ts`).name).toBe('later');
  });

  it('follows imports of other config files with their .ts extension', () => {
    const p = project({
      'shared.ts': 'export const NAME: string = "shared-name";\n',
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
import { NAME } from "./shared.ts";
export default defineConfig({ worker: { name: NAME, compatibilityDate: "2026-01-01" } });`,
    });
    expect(readCloudflareConfig(`${p.dir}/cloudflare.config.ts`).name).toBe('shared-name');
  });

  it('names a computed error message and a missing import', () => {
    const computed = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
const missing = ["CF_ACCOUNT_ID", "CF_ZONE"].filter((k) => !process.env[k]);
export default defineConfig(() => { throw new Error("missing environment: " + missing.join(", ")); });`,
    });
    expect(() => readCloudflareConfig(`${computed.dir}/cloudflare.config.ts`)).toThrow(
      /missing environment: CF_ACCOUNT_ID, CF_ZONE/,
    );
    const absent = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
import { NAME } from "./does-not-exist.ts";
export default defineConfig({ worker: { name: NAME } });`,
    });
    expect(() => readCloudflareConfig(`${absent.dir}/cloudflare.config.ts`)).toThrow(/does-not-exist/);
  });

  it('reports a config error readably', () => {
    const p = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
export default defineConfig(() => { throw new Error("no account id"); });`,
    });
    expect(() => readCloudflareConfig(`${p.dir}/cloudflare.config.ts`)).toThrow(/no account id/);
  });

  it('explains an account-level file without a worker', () => {
    const p = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
export default defineConfig({ accountId: "abc" });`,
    });
    expect(() => readCloudflareConfig(`${p.dir}/cloudflare.config.ts`)).toThrow(/no `worker`/);
  });

  it('is not confused by a config that prints to stdout', () => {
    const p = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
console.log("loading .env");
process.stdout.write("[dotenv] injected 3 variables\\n");
export default defineConfig({ worker: { name: "chatty", compatibilityDate: "2026-01-01" } });`,
    });
    expect(readCloudflareConfig(`${p.dir}/cloudflare.config.ts`).name).toBe('chatty');
  });

  it('returns the config even when something keeps the event loop alive', () => {
    const p = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
setInterval(() => {}, 1000);
export default defineConfig({ worker: { name: "lingering", compatibilityDate: "2026-01-01" } });`,
    });
    const started = Date.now();
    expect(readCloudflareConfig(`${p.dir}/cloudflare.config.ts`, { timeoutMs: 15_000 }).name).toBe(
      'lingering',
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('accepts a function or a promise as the worker', () => {
    const fn = project({
      'cloudflare.config.ts': `import { defineConfig, defineWorker } from "cf/config";
export default defineConfig({
  worker: defineWorker(({ mode }) => ({ name: mode === "staging" ? "fn-staging" : "fn", compatibilityDate: "2026-01-01" })),
});`,
    });
    expect(readCloudflareConfig(`${fn.dir}/cloudflare.config.ts`).name).toBe('fn');
    expect(readCloudflareConfig(`${fn.dir}/cloudflare.config.ts`, { mode: 'staging' }).name).toBe(
      'fn-staging',
    );
    const promised = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
export default defineConfig({ worker: Promise.resolve({ name: "later-worker", compatibilityDate: "2026-01-01" }) });`,
    });
    expect(readCloudflareConfig(`${promised.dir}/cloudflare.config.ts`).name).toBe('later-worker');
  });

  it('reads a config whose entry is a build output that does not exist yet', () => {
    const p = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
import * as entrypoint from "./.open-next/worker.js" with { type: "cf-worker" };
export default defineConfig({ worker: { name: "next-app", entrypoint, compatibilityDate: "2026-01-01" } });`,
    });
    expect(readCloudflareConfig(`${p.dir}/cloudflare.config.ts`).main).toBe('./.open-next/worker.js');
  });

  it('does not hand credentials from the CLI’s environment to the config', () => {
    const p = project({
      'cloudflare.config.ts': `import { defineConfig } from "cf/config";
const seen = [process.env.HYPDRIV_TEST_VISIBLE, process.env.HYPDRIV_TEST_API_TOKEN ?? "none", process.env.CLOUDFLARE_API_TOKEN ?? "none"];
export default defineConfig({ worker: { name: seen.join("|"), compatibilityDate: "2026-01-01" } });`,
    });
    const before = { ...process.env };
    process.env.HYPDRIV_TEST_VISIBLE = 'visible';
    process.env.HYPDRIV_TEST_API_TOKEN = 'hunter2';
    process.env.CLOUDFLARE_API_TOKEN = 'cf-secret';
    try {
      expect(readCloudflareConfig(`${p.dir}/cloudflare.config.ts`).name).toBe('visible|none|none');
      expect(readCloudflareConfig(`${p.dir}/cloudflare.config.ts`, { env: { ...process.env } }).name).toBe(
        'visible|hunter2|cf-secret',
      );
    } finally {
      for (const key of ['HYPDRIV_TEST_VISIBLE', 'HYPDRIV_TEST_API_TOKEN', 'CLOUDFLARE_API_TOKEN'])
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
    }
  });

  it('explains a top-level await that can never settle', () => {
    const p = project({
      'cloudflare.config.ts': 'await new Promise(() => {});\nexport default {};',
    });
    expect(() => readCloudflareConfig(`${p.dir}/cloudflare.config.ts`)).toThrow(
      /never finished|never settles/,
    );
  });

  it('gives up on a config that never finishes', () => {
    const p = project({
      'cloudflare.config.ts': 'await new Promise(() => setInterval(() => {}, 1000));\nexport default {};',
    });
    expect(() => evaluateCloudflareConfig(`${p.dir}/cloudflare.config.ts`, { timeoutMs: 800 })).toThrow(
      /timed out/,
    );
  });
});

describe('cloudflareConfigToWrangler()', () => {
  it('maps a hand-written evaluation result, ignoring plain values and unknown builders', () => {
    const doc = cloudflareConfigToWrangler(
      {
        worker: {
          name: 'w',
          entrypoint: { __cfWorker: '/app/src/worker.ts' },
          env: {
            PLAIN: 'not a builder',
            WEIRD: { __hypdriv: 'binding', kind: 'hyperdrive', args: [{}] },
            A: { __hypdriv: 'binding', kind: 'assets', args: [] },
          },
        },
      },
      '/app',
    );
    expect(doc).toEqual({ name: 'w', main: './src/worker.ts', assets: { binding: 'A' } });
  });

  it('relates a Windows entry path to the config directory', () => {
    const doc = cloudflareConfigToWrangler(
      { worker: { name: 'w', entrypoint: { __cfWorker: 'C:\\app\\src\\worker.ts' } } },
      'C:\\app',
    );
    expect(doc.main).toBe('./src/worker.ts');
    expect(
      cloudflareConfigToWrangler(
        { worker: { entrypoint: { __cfWorker: '/app/.open-next/worker.js' } } },
        '/app',
      ).main,
    ).toBe('./.open-next/worker.js');
  });

  it('maps the Durable Object class states', () => {
    const doc = cloudflareConfigToWrangler(
      {
        worker: {
          name: 'w',
          exports: {
            Live: { __hypdriv: 'export', kind: 'durableObject', args: [{ storage: 'sqlite' }] },
            Old: {
              __hypdriv: 'export',
              kind: 'durableObject',
              args: [{ state: 'renamed', renamedTo: 'Live' }],
            },
            Moved: { __hypdriv: 'export', kind: 'durableObject', args: [{ state: 'transferred' }] },
            Gone: { __hypdriv: 'export', kind: 'durableObject', args: [{ state: 'deleted' }] },
          },
        },
      },
      '/app',
    );
    expect(doc.migrations).toEqual([
      {
        tag: 'cloudflare.config.ts',
        new_sqlite_classes: ['Live'],
        deleted_classes: ['Gone'],
        renamed_classes: [{ from: 'Old', to: 'Live' }],
      },
    ]);
  });

  it('returns an empty document when there is no worker', () => {
    expect(cloudflareConfigToWrangler({ accountId: 'x' }, '/app')).toEqual({});
    expect(cloudflareConfigToWrangler(null, '/app')).toEqual({});
  });
});
