// Hypdriv's benchmarks: what the pipeline costs a request, and what its edge cache saves one.
//
//   pnpm build && pnpm -F @hypdriv/benchmarks bench
//   node run.mjs [--seconds 3] [--render 2,8,25] [--json results/pipeline.json]
//
// The built packages are measured (what an application installs), in one Node process, one request at a time: a
// request goes through createHandler(), the entry point of every host that is not the Worker shell, around an
// application that answers with a page. Nothing here crosses a network, so the numbers are the code's own time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { emptyManifest, routePatternToRegex } from '@hypdriv/core';
import { createHandler } from '@hypdriv/runtime';

const { values: args } = parseArgs({
  options: {
    seconds: { type: 'string', default: '3' },
    render: { type: 'string', default: '2,8,25' },
    json: { type: 'string' },
  },
});
const SECONDS = Number(args.seconds);
const RENDER_MS = args.render.split(',').map(Number);

// --- the application ------------------------------------------------------------------------------------------------
// A product page: a document of about 30 kB with what a rendered page has (inline data scripts, a stylesheet, module
// scripts), so that the stages that read or rewrite HTML have something to do.
const items = Array.from(
  { length: 120 },
  (_, i) =>
    `<li class="item"><a href="/products/${i}">Product ${i}</a><p>${'A sentence about this product. '.repeat(5)}</p></li>`,
).join('');
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Products</title><link rel="stylesheet" href="/assets/app-1a2b3c.css"><script type="module" src="/assets/app-4d5e6f.js"></script></head><body><main><h1>Products</h1><ul>${items}</ul></main><script>window.__DATA__ = ${JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `Product ${i}` })) })}</script><script>document.documentElement.dataset.ready = '1'</script></body></html>`;
const page = () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });

/** A render that costs CPU time, like a server render does: `ms` milliseconds of work, then the page. */
function renderer(ms) {
  if (ms === 0) return page;
  return () => {
    for (const end = performance.now() + ms; performance.now() < end; ) Math.sqrt(Math.random());
    return page();
  };
}

const route = (pathname, classification) => ({
  id: `page:${pathname}`,
  pathname,
  regex: routePatternToRegex(pathname),
  kind: 'page',
  classification,
  runtime: 'nodejs',
  dynamic: classification === 'dynamic',
  assets: { js: ['/assets/app-4d5e6f.js'], css: ['/assets/app-1a2b3c.css'], fonts: [] },
});
const manifest = emptyManifest({ buildId: 'bench', routes: [route('/products/[id]', 'dynamic')] });

// --- what is measured -----------------------------------------------------------------------------------------------
const handlerFor = (config) => createHandler({ config, manifest, target: 'node', development: false });
// By default Hypdriv writes a log line and a trace span for every request to the console. The lines are made and
// then dropped here: what a log sink costs is the platform's, and a terminal would be the slowest part of the run.
let lines = 0;
for (const method of ['log', 'info', 'debug', 'warn']) {
  console[method] = () => {
    lines++;
  };
}
const say = (text) => process.stdout.write(`${text}\n`);
const QUIET = { observe: { logging: { requests: false }, tracing: { exporter: 'none' } } };

/** Run `one()` for the given time; return what a request took. */
async function measure(one) {
  for (let i = 0; i < 300; i++) await one(i); // warm: code compiled, caches filled
  const times = [];
  const end = performance.now() + SECONDS * 1000;
  for (let i = 0; performance.now() < end; i++) {
    const t = performance.now();
    await one(i);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((n, t) => n + t, 0);
  const at = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
  return {
    requests: times.length,
    meanUs: Math.round((sum / times.length) * 1000),
    p50Us: Math.round(at(0.5) * 1000),
    p99Us: Math.round(at(0.99) * 1000),
    perSecond: Math.round(times.length / (sum / 1000)),
  };
}

const url = (i) => `https://shop.example/products/${i % 50}`;
const request = (i) =>
  new Request(url(i), {
    headers: { accept: 'text/html', 'accept-encoding': 'br, gzip', 'user-agent': 'Mozilla/5.0 (bench)' },
  });
const drain = async (response) => {
  await response.arrayBuffer();
  return response;
};

const report = {
  date: new Date().toISOString().slice(0, 10),
  machine: {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.availableParallelism(),
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
  },
  page: { bytes: Buffer.byteLength(PAGE) },
  seconds: SECONDS,
};

// 1. What the pipeline costs: the application answers at once, so everything measured is the way there and back.
{
  const upstream = renderer(0);
  const bare = await measure(async (i) => drain(await upstream(request(i))));
  const hypdriv = handlerFor({});
  let sample;
  lines = 0;
  const through = await measure(async (i) => {
    sample = await drain(await hypdriv(request(i), { upstream }));
  });
  const linesPerRequest = Math.round(lines / (through.requests + 300));
  // the same without the request log and the console span: the stages alone
  const silent = handlerFor(QUIET);
  const quiet = await measure(async (i) => drain(await silent(request(i), { upstream })));
  report.overhead = {
    application: bare,
    hypdriv: through,
    hypdrivQuiet: quiet,
    addedUs: through.meanUs - bare.meanUs,
    addedQuietUs: quiet.meanUs - bare.meanUs,
    linesPerRequest,
    headers: [...sample.headers.keys()].sort(),
    csp: sample.headers.get('x-hypdriv-csp'),
  };
  say(
    `pipeline: ${bare.meanUs} µs without, ${through.meanUs} µs with Hypdriv (+${through.meanUs - bare.meanUs} µs a request, ${linesPerRequest} log lines each; +${quiet.meanUs - bare.meanUs} µs without them; p99 ${through.p99Us} µs)`,
  );
}

// 2. What the edge cache saves: an application whose render costs CPU time, with and without a policy for the route.
report.cache = [];
for (const ms of RENDER_MS) {
  const upstream = renderer(ms);
  const bare = await measure(async (i) => drain(await upstream(request(i))));
  const plain = handlerFor({ cache: { edge: false } });
  const uncached = await measure(async (i) => drain(await plain(request(i), { upstream })));
  const cached = handlerFor({ cache: { edge: { policies: [{ match: '/products/:id', ttl: '5m' }] } } });
  let state;
  const hit = await measure(async (i) => {
    const r = await drain(await cached(request(i), { upstream }));
    state = r.headers.get('x-hypdriv-cache');
  });
  if (!/hit/i.test(state ?? ''))
    throw new Error(`the cached handler did not answer from its cache (x-hypdriv-cache: ${state})`);
  report.cache.push({
    renderMs: ms,
    application: bare,
    hypdrivNoCache: uncached,
    hypdrivCached: hit,
    speedup: Number((bare.meanUs / hit.meanUs).toFixed(1)),
  });
  say(
    `render ${ms} ms: ${bare.perSecond}/s without Hypdriv, ${uncached.perSecond}/s through the pipeline, ${hit.perSecond}/s from the edge cache (${(bare.meanUs / hit.meanUs).toFixed(1)}x)`,
  );
}

if (args.json) {
  const file = path.resolve(args.json);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}
