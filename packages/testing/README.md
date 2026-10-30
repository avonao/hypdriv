# @hypdriv/testing

Testing kit for [HypDriv](https://github.com/avonao/hypdriv) packages and applications: in-memory fakes for every Cloudflare binding HypDriv knows (`KVNamespace`, `Cache`, `DurableObjectNamespace`, `Queue`, `AnalyticsEngine`, `ExecutionContext`, Rate Limiting), a controllable clock, a Drivetrain harness (`createTestContext`, `runStage`), header/cookie assertions and vitest presets for Node and Workers projects.

The fakes implement the structural `*Like` interfaces from `@hypdriv/core`, so a stage or store written against `KVNamespaceLike` or `CacheLike` runs unchanged in plain Node tests; the Workers preset runs the same files inside workerd when you need the real thing.

## Install

```sh
pnpm add -D @hypdriv/testing vitest
pnpm add -D @cloudflare/vitest-plugin wrangler   # only for Workers-runtime projects
```

## Fakes

```ts
import { createClock, createFakeCache, createFakeDurableObjectNamespace, createFakeKV } from '@hypdriv/testing';

const clock = createClock(); // starts at 2026-01-01T00:00:00Z and only moves when told to
const kv = createFakeKV({ clock });
await kv.put('flags', '{"beta":{"default":true}}', { expirationTtl: 60, metadata: { v: 1 } });
clock.tick(61);
await kv.get('flags'); // null — expired
await kv.list({ prefix: 'f', limit: 10 }); // { keys, list_complete, cursor? } with expiration + metadata
kv.reads; // call counters for memoisation assertions

const cache = createFakeCache({ clock }); // caches.default semantics
await cache.put('https://app.test/', new Response('x', { headers: { 'cache-control': 's-maxage=30' } }));
clock.tick(31);
await cache.match('https://app.test/'); // undefined — expired; no-store/private/Set-Cookie are never stored

const ns = createFakeDurableObjectNamespace((id) => {
  let count = 0;
  return {
    async fetch(request) { return Response.json({ name: id.name, count: ++count }); },
    increment: () => ++count, // RPC-style methods are reachable through the stub, as promises
  };
});
const stub = ns.get(ns.idFromName('room-1')); // deterministic 64-hex id, instance memoised per id
await stub.fetch('/events'); // relative URLs allowed
ns.fetches; // every request that reached an object
```

Also: `createFakeQueue()` (`send`, `sendBatch`, `messages`, `drain()`), `createFakeAnalyticsEngine()` (`dataPoints`), `createFakeExecutionContext()` (`waitUntil`, `await ctx.flush()`, `errors`, `passedThrough`), `createFakeRateLimitBinding({ limit, periodSeconds })` (fixed windows on the clock).

## Harness

```ts
import { createTestContext, expectHeaders, collectSetCookies, runStage, runStages } from '@hypdriv/testing';
import { flagsStage, staticProvider } from '@hypdriv/flags';

const ctx = createTestContext({
  url: 'https://shop.example.com/pricing',
  headers: { cookie: 'hyp_uid=abc' },
  cf: { country: 'US' }, // attached to request.cf and ctx.cf
  config: { flags: { definitions: { beta: { default: false, rules: [{ percentage: 50, value: true }] } } } },
  development: true,
});
const { response, shortCircuited, forwarded, timings } = await runStage(flagsStage(ctx.config, staticProvider(ctx.config.flags.definitions)), ctx);
expectHeaders(response, { 'x-request-id': /./, 'x-powered-by': null }); // throws one readable error listing every mismatch
collectSetCookies(response); // ['hyp_uid=...; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax']
forwarded?.headers.get('x-hypdriv-flags'); // what Next.js would receive
```

`runStage(stage, ctx, next?)` runs `pre` → `next` (default `200 ok`) → `post` through core's `runPipeline`, so internal-path/RSC filters, timings and `ctx.responseHeaders` merging behave exactly like production. `runStages(stages, ctx, next?, options?)` runs several. `requestWithCf(url, init, cf)` builds a request with `cf`; `withEnv(env, fn)` exposes `globalThis.__hypdriv_test_env__` for the duration of `fn`; `parseSetCookie`, `responseJson`, `responseText` round things off.

## Vitest presets

```ts
// vitest.config.ts — Node project
import { defineHypDrivNodeConfig } from '@hypdriv/testing/vitest';
export default defineHypDrivNodeConfig('my-package');

// vitest.workers.config.ts — Workers project (loads @cloudflare/vitest-plugin lazily)
import { defineHypDrivWorkersConfig } from '@hypdriv/testing/vitest';
export default defineHypDrivWorkersConfig('my-package-workers', {
  main: './src/test-worker.ts',
  durableObjects: { HYPDRIV_CHANNEL: 'HypDrivChannel' }, // SQLite-backed by default
  kvNamespaces: ['HYPDRIV_KV'],
});
```

`hypdrivNodeProject(name, options)` and `hypdrivWorkersProject(name, options)` return the plain objects (`config` + `workersOptions` for `cloudflareTest()`) when you prefer composing configs yourself; neither imports the Cloudflare plugin. Workers test files are named `*.workers.test.ts` and excluded from the Node project.

## License

MIT
