// Write docs/benchmarks.md from results/pipeline.json: `node report.mjs`.
// Every number and every sentence that compares numbers is computed here, so the text cannot drift from the tables.
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const r = JSON.parse(fs.readFileSync(path.join(here, 'results/pipeline.json'), 'utf8'));
const int = (n) => Math.round(n).toLocaleString('en-US');
const ms = (us) => (us >= 10000 ? (us / 1000).toFixed(1) : (us / 1000).toFixed(2));

const o = r.overhead;
let md = `# Benchmarks

Two questions: what does Hypdriv cost a request, and what does it save one. Both are answered on the built packages, in one Node process, one request at a time, with [\`benchmarks/run.mjs\`](../benchmarks/run.mjs); this page is written from its result file by \`benchmarks/report.mjs\`. Nothing here crosses a network: the numbers are the code's own time, which is what a Worker is billed for and what a Node server's throughput is made of.

A request goes through \`createHandler()\` (the entry point of every host that is not the Worker shell) around an application that answers with a product page of ${int(r.page.bytes / 1000)} kB of HTML: a stylesheet, a module script, two inline scripts. Measured on ${r.date} with Node ${r.machine.node} on ${r.machine.cores} cores (${r.machine.cpu}, ${r.machine.platform}), ${r.seconds} seconds a row after 300 warm-up requests.

## What the pipeline costs

The application answers at once, so everything measured is the way through Hypdriv and back: the request context, the security headers, a content security policy with a nonce for this response written into every script of the page, rate-limit accounting, the cache decision, timings.

| | Mean | Median | 99th percentile | Requests a second |
| --- | ---: | ---: | ---: | ---: |
| The application alone | ${ms(o.application.meanUs)} ms | ${ms(o.application.p50Us)} ms | ${ms(o.application.p99Us)} ms | ${int(o.application.perSecond)} |
| Through Hypdriv, defaults | ${ms(o.hypdriv.meanUs)} ms | ${ms(o.hypdriv.p50Us)} ms | ${ms(o.hypdriv.p99Us)} ms | ${int(o.hypdriv.perSecond)} |
| Through Hypdriv, without the request log and the console span | ${ms(o.hypdrivQuiet.meanUs)} ms | ${ms(o.hypdrivQuiet.p50Us)} ms | ${ms(o.hypdrivQuiet.p99Us)} ms | ${int(o.hypdrivQuiet.perSecond)} |

Hypdriv adds **${ms(o.addedUs)} ms** of processor time to a request (${int(o.addedUs)} µs), for a response that now carries ${o.headers.length} headers (\`${o.headers
  .filter((h) => !h.startsWith('x-hypdriv') && h !== 'content-type')
  .slice(0, 8)
  .join(
    '`, `',
  )}\`, …) and a ${o.csp} content security policy. By default it also writes ${o.linesPerRequest} lines for every request, a log line and a trace span; they are made and then dropped in this measurement, because what a log sink costs is the platform's. Without them (\`observe.logging.requests: false\`, \`observe.tracing.exporter: 'none'\`) the pipeline adds ${ms(o.addedQuietUs)} ms.

A profile of this path (\`node --cpu-prof benchmarks/prof.mjs through\`) shows about a quarter of the time in reading the page to give its scripts their nonce, and much of the rest in Node's own \`Request\`, \`Response\`, \`Headers\` and stream objects. On Workers the nonce is written with \`HTMLRewriter\` and those objects are the runtime's own, which this page does not measure.

## What the edge cache saves

The same page from an application whose render costs processor time, as a server render does. Three rows each: the application alone, through Hypdriv with the edge cache off (the pipeline's cost on top of the render), and with one policy for the route (\`{ match: '/products/:id', ttl: '5m' }\`), answered from the cache after the first request for each of 50 products.

| Render | The application alone | Through Hypdriv, cache off | From the edge cache | Gain |
| --- | ---: | ---: | ---: | ---: |
`;
for (const row of r.cache) {
  md += `| ${row.renderMs} ms | ${int(row.application.perSecond)}/s (${ms(row.application.meanUs)} ms) | ${int(row.hypdrivNoCache.perSecond)}/s (${ms(row.hypdrivNoCache.meanUs)} ms) | **${int(row.hypdrivCached.perSecond)}/s** (${ms(row.hypdrivCached.meanUs)} ms) | **${row.speedup}×** |\n`;
}
const [least, most] = [r.cache[0], r.cache[r.cache.length - 1]];
md += `
A cached answer costs ${ms(least.hypdrivCached.meanUs)} ms whatever the render costs, so the gain grows with the render: ${least.speedup} times the requests a second for a render of ${least.renderMs} ms, ${most.speedup} times for one of ${most.renderMs} ms. The first request for a page still pays for the render (and with \`swr\` a visitor never waits for the one that refreshes it).

On Cloudflare the same policy is answered from the colo's memory, then the Cache API, then KV; on Vercel it becomes \`Vercel-CDN-Cache-Control\` and the CDN answers before the function starts. Those tiers add network distance this page does not measure; the live suites in \`e2e/\` verify them on real accounts.

## What to keep in mind

- One process, one request at a time, no network. A deployment adds TLS, the platform's own routing and the distance to the visitor to every row equally.
- The page and the render are synthetic: the render is a loop that burns the stated time. What a real render costs is the first column; find yours there.
- No other tool is measured. Hypdriv is a sidecar for an application that already has a framework and a platform; the comparison that decides is the application with and without it, which is what these tables are.
- The pipeline's cost depends on what is turned on. These are the defaults; HTML transforms, bot checks and a remote rate-limit store each add their own.
`;
fs.mkdirSync(path.join(here, '..', 'docs'), { recursive: true });
fs.writeFileSync(path.join(here, '..', 'docs', 'benchmarks.md'), md);
console.log(`wrote docs/benchmarks.md (${md.length} characters)`);
