import type { HypManifest } from '@hypdriv/core';
import { readText, rel } from '../../util/fs';
import type { WranglerConfig } from '../../wrangler-config';
import { type Check, type CheckResult, fail, info, pass, skip, warn } from '../types';

/** What an `open-next.config.ts` configures, read from its source text (no evaluation). */
export interface OpenNextCacheSetup {
  incrementalCache: 'r2' | 'kv' | 'static-assets' | 'custom' | null;
  regionalCache: boolean;
  queue: 'do' | 'memory' | 'custom' | null;
  tagCache: 'do-sharded' | 'd1' | 'kv' | 'custom' | null;
  cachePurge: 'durable-object' | 'direct' | 'custom' | null;
}

const OVERRIDE = (path: string) =>
  new RegExp(`from\\s+['"]@opennextjs/cloudflare/overrides/${path}(?:\\.js)?['"]`);

/** Text of the `defineCloudflareConfig({...})` call with comments removed. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
}

/** Detects the cache overrides of an `open-next.config.ts` from its imports and option keys. */
export function readOpenNextCacheSetup(source: string): OpenNextCacheSetup {
  const text = stripComments(source);
  const has = (key: string) => new RegExp(`\\b${key}\\s*:`).test(text);
  const imports = (path: string) => OVERRIDE(path).test(text);

  const incrementalCache = !has('incrementalCache')
    ? null
    : imports('incremental-cache/r2-incremental-cache')
      ? 'r2'
      : imports('incremental-cache/kv-incremental-cache')
        ? 'kv'
        : imports('incremental-cache/static-assets-incremental-cache')
          ? 'static-assets'
          : 'custom';
  const queue = !has('queue')
    ? null
    : imports('queue/do-queue')
      ? 'do'
      : imports('queue/memory-queue')
        ? 'memory'
        : 'custom';
  const tagCache = !has('tagCache')
    ? null
    : imports('tag-cache/do-sharded-tag-cache')
      ? 'do-sharded'
      : imports('tag-cache/d1-next-tag-cache')
        ? 'd1'
        : imports('tag-cache/kv-next-tag-cache')
          ? 'kv'
          : 'custom';
  const purgeCall = /purgeCache\s*\(\s*\{[^}]*type\s*:\s*['"](durableObject|direct)['"]/.exec(text);
  const cachePurge = !has('cachePurge')
    ? null
    : imports('cache-purge(?:/index)?')
      ? purgeCall?.[1] === 'durableObject'
        ? 'durable-object'
        : 'direct'
      : 'custom';
  return {
    incrementalCache,
    regionalCache: imports('incremental-cache/regional-cache') && /withRegionalCache\s*\(/.test(text),
    queue,
    tagCache,
    cachePurge,
  };
}

export interface BindingRequirement {
  /** Binding name OpenNext reads from `env`. */
  binding: string;
  kind: 'r2' | 'kv' | 'd1' | 'durable-object' | 'service' | 'assets';
  /** Durable Object class the binding must point at (exported by the Worker entry). */
  className?: string;
  /** What needs it. */
  for: string;
}

/** The bindings the configured overrides read at run time. */
export function openNextBindingRequirements(setup: OpenNextCacheSetup): BindingRequirement[] {
  const out: BindingRequirement[] = [];
  if (setup.incrementalCache === 'r2')
    out.push({ binding: 'NEXT_INC_CACHE_R2_BUCKET', kind: 'r2', for: 'the R2 incremental cache' });
  if (setup.incrementalCache === 'kv')
    out.push({ binding: 'NEXT_INC_CACHE_KV', kind: 'kv', for: 'the KV incremental cache' });
  if (setup.incrementalCache === 'static-assets')
    out.push({ binding: 'ASSETS', kind: 'assets', for: 'the static-assets incremental cache' });
  if (setup.queue === 'do') {
    out.push({
      binding: 'NEXT_CACHE_DO_QUEUE',
      kind: 'durable-object',
      className: 'DOQueueHandler',
      for: 'the ISR revalidation queue',
    });
    out.push({
      binding: 'WORKER_SELF_REFERENCE',
      kind: 'service',
      for: 'ISR revalidation requests (the queue re-requests pages through the Worker itself)',
    });
  }
  if (setup.tagCache === 'do-sharded')
    out.push({
      binding: 'NEXT_TAG_CACHE_DO_SHARDED',
      kind: 'durable-object',
      className: 'DOShardedTagCache',
      for: 'the sharded tag cache',
    });
  if (setup.tagCache === 'd1')
    out.push({ binding: 'NEXT_TAG_CACHE_D1', kind: 'd1', for: 'the D1 tag cache' });
  if (setup.tagCache === 'kv')
    out.push({ binding: 'NEXT_TAG_CACHE_KV', kind: 'kv', for: 'the KV tag cache' });
  if (setup.cachePurge === 'durable-object')
    out.push({
      binding: 'NEXT_CACHE_DO_PURGE',
      kind: 'durable-object',
      className: 'BucketCachePurge',
      for: 'batched zone cache purges',
    });
  return out;
}

function declared(cfg: WranglerConfig, req: BindingRequirement): { ok: boolean; problem?: string } {
  switch (req.kind) {
    case 'r2':
      return { ok: cfg.r2_buckets.some((b) => b.binding === req.binding) };
    case 'kv':
      return { ok: cfg.kv_namespaces.some((b) => b.binding === req.binding) };
    case 'd1':
      return { ok: cfg.d1_databases.some((b) => b.binding === req.binding) };
    case 'service':
      return { ok: cfg.services.some((b) => b.binding === req.binding) };
    case 'assets':
      return { ok: cfg.assets?.binding === req.binding };
    case 'durable-object': {
      const binding = cfg.durable_objects.bindings.find((b) => b.name === req.binding);
      if (!binding) return { ok: false };
      if (req.className && binding.class_name !== req.className)
        return {
          ok: false,
          problem: `${req.binding} points at ${String(binding.class_name)}, expected ${req.className}`,
        };
      return { ok: true };
    }
  }
}

function snippet(req: BindingRequirement): string {
  switch (req.kind) {
    case 'r2':
      return `"r2_buckets": [{ "binding": "${req.binding}", "bucket_name": "<name>-opennext-cache" }]`;
    case 'kv':
      return `"kv_namespaces": [{ "binding": "${req.binding}", "id": "<namespace id>" }]`;
    case 'd1':
      return `"d1_databases": [{ "binding": "${req.binding}", "database_name": "<name>", "database_id": "<id>" }]`;
    case 'service':
      return `"services": [{ "binding": "${req.binding}", "service": "<worker name>" }]`;
    case 'assets':
      return `"assets": { "directory": ".open-next/assets", "binding": "${req.binding}" }`;
    case 'durable-object':
      return `"durable_objects": { "bindings": [{ "name": "${req.binding}", "class_name": "${req.className}" }] } + a migration with "new_sqlite_classes": ["${req.className}"]`;
  }
}

function isrRoutes(manifest: HypManifest | null): number | null {
  if (!manifest) return null;
  return manifest.routes.filter((r) => r.classification === 'isr').length;
}

export interface OpenNextCacheInput {
  setup: OpenNextCacheSetup;
  wrangler: WranglerConfig | null;
  /** Source of the Worker entry (`hypdriv.worker.ts`), when there is one. */
  workerSource: string | null;
  workerFile: string | null;
  manifest: HypManifest | null;
}

/** Evaluates the OpenNext cache setup against the wrangler bindings and the Worker entry's exports. */
export function evaluateOpenNextCache(input: OpenNextCacheInput): CheckResult {
  const { setup, wrangler } = input;
  const errors: string[] = [];
  const advice: string[] = [];
  if (wrangler) {
    for (const req of openNextBindingRequirements(setup)) {
      const result = declared(wrangler, req);
      if (!result.ok)
        errors.push(result.problem ?? `${req.binding} (${req.for}) is not bound: ${snippet(req)}`);
    }
  }
  if (input.workerSource) {
    const classes = openNextBindingRequirements(setup)
      .map((r) => r.className)
      .filter((c): c is string => !!c);
    const source = stripComments(input.workerSource);
    const reExportsAll = /export\s*\*\s*from\s*['"][^'"]*\.open-next\/worker(?:\.js)?['"]/.test(source);
    const exported = (name: string) =>
      reExportsAll ||
      new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source) ||
      new RegExp(`export\\s+(?:class|const|let|var)\\s+${name}\\b`).test(source);
    const missing = classes.filter((c) => !exported(c));
    if (missing.length)
      errors.push(
        `${input.workerFile ?? 'the Worker entry'} does not export ${missing.join(', ')}: \`export { ${missing.join(', ')} } from './.open-next/worker.js';\``,
      );
  }

  const isr = isrRoutes(input.manifest);
  if (!setup.incrementalCache)
    advice.push(
      'No incrementalCache: prerendered pages and the data cache are not persisted between isolates (use r2IncrementalCache, ideally inside withRegionalCache).',
    );
  if (!setup.queue)
    advice.push(
      `No queue: time-based ISR revalidation never runs on Cloudflare (OpenNext's default queue is a no-op)${isr ? `; ${isr} ISR route(s) in the manifest stay stale forever` : ''}. Use doQueue.`,
    );
  if (!setup.tagCache)
    advice.push(
      "No tagCache: revalidateTag()/revalidatePath() and 'use cache' tags have no effect on Cloudflare (OpenNext's default tag cache is a no-op). Use doShardedTagCache.",
    );
  if (setup.queue === 'memory')
    advice.push(
      'memoryQueue revalidates inside the requesting isolate only; doQueue dedupes across isolates.',
    );
  if (setup.incrementalCache && setup.incrementalCache !== 'static-assets' && !setup.regionalCache)
    advice.push(
      'Wrap the incremental cache in withRegionalCache(…, { mode: "long-lived" }) to serve hits from the Cache API.',
    );
  if (setup.tagCache && !setup.cachePurge && setup.regionalCache)
    advice.push(
      'withRegionalCache without cachePurge: revalidated pages stay in other data centres until the regional cache refreshes. Add purgeCache({ type: "durableObject" }) with CACHE_PURGE_ZONE_ID/CACHE_PURGE_API_TOKEN.',
    );

  const summary = [
    `incremental cache ${setup.incrementalCache ?? 'none'}${setup.regionalCache ? ' + regional' : ''}`,
    `queue ${setup.queue ?? 'none'}`,
    `tag cache ${setup.tagCache ?? 'none'}`,
    `purge ${setup.cachePurge ?? 'none'}`,
  ].join(' · ');
  if (errors.length)
    return fail(`OpenNext cache overrides are missing what they need at run time (${summary}).`, {
      details: [...errors, ...advice],
    });
  if (!setup.queue && isr)
    return warn(`${isr} ISR route(s) but no revalidation queue (${summary}).`, { details: advice });
  if (advice.length) return warn(summary, { details: advice });
  return pass(summary);
}

export const openNextCacheChecks: Check[] = [
  {
    id: 'opennext.cache',
    title: 'OpenNext cache setup (incremental cache, queue, tag cache, purge)',
    category: 'opennext',
    severity: 'warn',
    run(ctx) {
      const file = ctx.project.openNextConfigFile;
      if (!file) return skip('no open-next.config.ts.');
      const source = readText(file);
      if (source === null) return info(`${rel(ctx.root, file)} could not be read.`);
      const workerFile = ctx.project.hypdrivWorkerFile ?? null;
      return evaluateOpenNextCache({
        setup: readOpenNextCacheSetup(source),
        wrangler: ctx.project.wrangler.config,
        workerSource: workerFile ? readText(workerFile) : null,
        workerFile: workerFile ? rel(ctx.root, workerFile) : null,
        manifest: ctx.manifest,
      });
    },
  },
];
