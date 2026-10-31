import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emptyManifest, type HypRoute, resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { parseWranglerConfig } from '../../wrangler-config';
import {
  evaluateEdgeCacheMiddleware,
  evaluateOpenNextCache,
  openNextBindingRequirements,
  readOpenNextCacheSetup,
} from './opennext-cache';

const example = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../examples/basic/${file}`, import.meta.url)), 'utf8');

const FULL = example('open-next.config.ts');
const WRANGLER = parseWranglerConfig(example('wrangler.jsonc'), 'jsonc');
const WORKER = example('hypdriv.worker.ts');

const isrManifest = emptyManifest({
  routes: [{ id: 'app:/blog/[slug]', classification: 'isr' } as HypRoute],
});

describe('readOpenNextCacheSetup', () => {
  it('reads the production setup of the examples', () => {
    expect(readOpenNextCacheSetup(FULL)).toEqual({
      incrementalCache: 'r2',
      regionalCache: true,
      queue: 'do',
      tagCache: 'do-sharded',
      cachePurge: 'durable-object',
    });
  });

  it('treats a bare config as OpenNext defaults (no cache, dummy queue and tag cache)', () => {
    expect(
      readOpenNextCacheSetup(
        "import { defineCloudflareConfig } from '@opennextjs/cloudflare';\nexport default defineCloudflareConfig({});\n",
      ),
    ).toEqual({
      incrementalCache: null,
      regionalCache: false,
      queue: null,
      tagCache: null,
      cachePurge: null,
    });
  });

  it('ignores commented-out overrides and recognises the other stores', () => {
    const setup = readOpenNextCacheSetup(`
      import kvIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache';
      import d1NextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache";
      import memoryQueue from '@opennextjs/cloudflare/overrides/queue/memory-queue';
      import purgeCache from '@opennextjs/cloudflare/overrides/cache-purge/index';
      export default defineCloudflareConfig({
        incrementalCache: kvIncrementalCache,
        tagCache: d1NextTagCache,
        queue: memoryQueue,
        // cachePurge: purgeCache({ type: 'durableObject' }),
        /* enableCacheInterception: true, */
      });`);
    expect(setup).toEqual({
      incrementalCache: 'kv',
      regionalCache: false,
      queue: 'memory',
      tagCache: 'd1',
      cachePurge: null,
    });
    expect(openNextBindingRequirements(setup).map((r) => r.binding)).toEqual([
      'NEXT_INC_CACHE_KV',
      'NEXT_TAG_CACHE_D1',
    ]);
    expect(
      readOpenNextCacheSetup(
        "cachePurge: purgeCache({ type: 'direct' }), from '@opennextjs/cloudflare/overrides/cache-purge/index'",
      ).cachePurge,
    ).toBe('direct');
  });
});

describe('evaluateOpenNextCache', () => {
  it('passes the examples: every override has its binding and the Worker exports the classes', () => {
    const result = evaluateOpenNextCache({
      setup: readOpenNextCacheSetup(FULL),
      wrangler: WRANGLER,
      workerSource: WORKER,
      workerFile: 'hypdriv.worker.ts',
      manifest: isrManifest,
    });
    expect(result.status).toBe('pass');
    expect(result.message).toBe(
      'incremental cache r2 + regional · queue do · tag cache do-sharded · purge durable-object',
    );
  });

  it('fails when a Durable Object binding, the self reference or an export is missing', () => {
    const wrangler = parseWranglerConfig(
      example('wrangler.jsonc')
        .replace(/\s*\{ "name": "NEXT_CACHE_DO_QUEUE"[^}]*\},/, '')
        .replace('"class_name": "BucketCachePurge"', '"class_name": "HypDrivIndex"')
        .replace(/"services": \[[^\]]*\],/, ''),
      'jsonc',
    );
    const result = evaluateOpenNextCache({
      setup: readOpenNextCacheSetup(FULL),
      wrangler,
      workerSource: `${WORKER.replace(', DOShardedTagCache', '')}\n// DOShardedTagCache is mentioned in a comment only\n`,
      workerFile: 'hypdriv.worker.ts',
      manifest: null,
    });
    expect(result.status).toBe('fail');
    expect(result.details?.join('\n')).toContain(
      'NEXT_CACHE_DO_QUEUE (the ISR revalidation queue) is not bound',
    );
    expect(result.details?.join('\n')).toContain('WORKER_SELF_REFERENCE');
    expect(result.details?.join('\n')).toContain(
      'NEXT_CACHE_DO_PURGE points at HypDrivIndex, expected BucketCachePurge',
    );
    expect(result.details?.join('\n')).toContain('hypdriv.worker.ts does not export DOShardedTagCache');
  });

  it('fails when hash-CSP routes have no incremental cache to serve their prerendered HTML', () => {
    const hashManifest = emptyManifest({
      routes: [{ id: 'app:/', classification: 'static' } as HypRoute],
      csp: { 'app:/': { scriptHashes: ['sha256-abc'], styleHashes: [] } },
    });
    const bare = evaluateOpenNextCache({
      setup: readOpenNextCacheSetup('export default defineCloudflareConfig({});'),
      wrangler: WRANGLER,
      workerSource: WORKER,
      workerFile: 'hypdriv.worker.ts',
      manifest: hashManifest,
    });
    expect(bare.status).toBe('fail');
    expect(bare.message).toContain('1 route(s) use a hash CSP');
    expect(bare.message).toContain("security.csp.mode to 'nonce'");
    const full = evaluateOpenNextCache({
      setup: readOpenNextCacheSetup(FULL),
      wrangler: WRANGLER,
      workerSource: WORKER,
      workerFile: 'hypdriv.worker.ts',
      manifest: hashManifest,
    });
    expect(full.status).toBe('pass');
  });

  it('warns that ISR and tag revalidation are no-ops with OpenNext defaults', () => {
    const result = evaluateOpenNextCache({
      setup: readOpenNextCacheSetup('export default defineCloudflareConfig({});'),
      wrangler: WRANGLER,
      workerSource: WORKER,
      workerFile: 'hypdriv.worker.ts',
      manifest: isrManifest,
    });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('1 ISR route(s) but no revalidation queue');
    expect(result.details?.join('\n')).toContain('revalidateTag()/revalidatePath()');
  });
});

describe('evaluateOpenNextCache: sites that never revalidate', () => {
  const staticManifest = emptyManifest({ routes: [{ id: 'app:/', classification: 'static' } as HypRoute] });
  const staticAssets = readOpenNextCacheSetup(
    "import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';\nexport default defineCloudflareConfig({ incrementalCache: staticAssetsIncrementalCache });",
  );
  const run = (usesRevalidation: boolean | null, manifest = staticManifest) =>
    evaluateOpenNextCache({
      setup: staticAssets,
      wrangler: parseWranglerConfig(
        '{ "name": "x", "assets": { "directory": ".open-next/assets", "binding": "ASSETS" } }',
        'jsonc',
      ),
      workerSource: null,
      workerFile: null,
      manifest,
      usesRevalidation,
    });

  it('stays quiet when there are no ISR routes and the sources never invalidate or tag', () => {
    expect(run(false).status).toBe('pass');
  });

  it('still asks for a tag cache when the sources call revalidateTag / revalidatePath / "use cache", or were not scanned', () => {
    for (const uses of [true, null]) {
      const result = run(uses);
      expect(result.status).toBe('warn');
      expect(result.details?.join('\n')).toContain('revalidateTag()/revalidatePath()');
    }
  });

  it('asks for a queue only where ISR routes exist', () => {
    const quiet = run(true);
    expect(quiet.details?.join('\n')).not.toContain('No queue');
    const isr = run(true, isrManifest);
    expect(isr.message).toContain('1 ISR route(s) but no revalidation queue');
  });
});

describe('evaluateEdgeCacheMiddleware', () => {
  const withMiddleware = emptyManifest({
    routes: [{ id: 'app:/', classification: 'static' } as HypRoute],
    proxy: { matchers: [{ source: '/:path*', sourceRegex: '^/(.*)$' }] },
  });
  const edgeOf = (cache?: object) => resolveConfig({ cache } as never).cache.edge;

  it('warns when a middleware sits behind an edge cache that bypasses nothing', () => {
    const r = evaluateEdgeCacheMiddleware({ manifest: withMiddleware, edge: edgeOf() });
    expect(r.status).toBe('warn');
    expect(r.message).toContain('a cache HIT never reaches it');
    expect(r.details?.join('\n')).toContain('cache.edge.bypass');
  });

  it('passes once the gate cookie is listed', () => {
    const r = evaluateEdgeCacheMiddleware({
      manifest: withMiddleware,
      edge: edgeOf({ edge: { bypass: { cookies: ['tv_gate'] } } }),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toContain('cookies tv_gate');
  });

  it('passes without middleware, with the edge cache off, or with no policies', () => {
    expect(evaluateEdgeCacheMiddleware({ manifest: emptyManifest({}), edge: edgeOf() }).status).toBe('pass');
    expect(
      evaluateEdgeCacheMiddleware({ manifest: withMiddleware, edge: edgeOf({ edge: false }) }).status,
    ).toBe('pass');
    expect(
      evaluateEdgeCacheMiddleware({ manifest: withMiddleware, edge: edgeOf({ edge: { infer: false } }) })
        .status,
    ).toBe('pass');
  });
});
