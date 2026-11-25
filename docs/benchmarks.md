# Benchmarks

Two questions: what does Hypdriv cost a request, and what does it save one. Both are answered on the built packages, in one Node process, one request at a time, with [`benchmarks/run.mjs`](../benchmarks/run.mjs); this page is written from its result file by `benchmarks/report.mjs`. Nothing here crosses a network: the numbers are the code's own time, which is what a Worker is billed for and what a Node server's throughput is made of.

A request goes through `createHandler()` (the entry point of every host that is not the Worker shell) around an application that answers with a product page of 28 kB of HTML: a stylesheet, a module script, two inline scripts. Measured on 2026-11-25 with Node v22.23.4 on 2 cores (Intel(R) Xeon(R) Processor, linux x64), 3 seconds a row after 300 warm-up requests.

## What the pipeline costs

The application answers at once, so everything measured is the way through Hypdriv and back: the request context, the security headers, a content security policy with a nonce for this response written into every script of the page, rate-limit accounting, the cache decision, timings.

| | Mean | Median | 99th percentile | Requests a second |
| --- | ---: | ---: | ---: | ---: |
| The application alone | 0.02 ms | 0.02 ms | 0.10 ms | 41,595 |
| Through Hypdriv, defaults | 0.66 ms | 0.61 ms | 1.31 ms | 1,506 |
| Through Hypdriv, without the request log and the console span | 0.57 ms | 0.52 ms | 1.34 ms | 1,766 |

Hypdriv adds **0.64 ms** of processor time to a request (640 µs), for a response that now carries 20 headers (`cache-control`, `content-security-policy`, `cross-origin-opener-policy`, `cross-origin-resource-policy`, `link`, `origin-agent-cluster`, `permissions-policy`, `referrer-policy`, …) and a nonce content security policy. By default it also writes 2 lines for every request, a log line and a trace span; they are made and then dropped in this measurement, because what a log sink costs is the platform's. Without them (`observe.logging.requests: false`, `observe.tracing.exporter: 'none'`) the pipeline adds 0.54 ms.

A profile of this path (`node --cpu-prof benchmarks/prof.mjs through`) shows about a quarter of the time in reading the page to give its scripts their nonce, and much of the rest in Node's own `Request`, `Response`, `Headers` and stream objects. On Workers the nonce is written with `HTMLRewriter` and those objects are the runtime's own, which this page does not measure.

## What the edge cache saves

The same page from an application whose render costs processor time, as a server render does. Three rows each: the application alone, through Hypdriv with the edge cache off (the pipeline's cost on top of the render), and with one policy for the route (`{ match: '/products/:id', ttl: '5m' }`), answered from the cache after the first request for each of 50 products.

| Render | The application alone | Through Hypdriv, cache off | From the edge cache | Gain |
| --- | ---: | ---: | ---: | ---: |
| 2 ms | 481/s (2.08 ms) | 359/s (2.79 ms) | **1,430/s** (0.70 ms) | **3×** |
| 8 ms | 124/s (8.09 ms) | 114/s (8.77 ms) | **1,522/s** (0.66 ms) | **12.3×** |
| 25 ms | 40/s (25.1 ms) | 39/s (25.9 ms) | **1,433/s** (0.70 ms) | **36×** |

A cached answer costs 0.70 ms whatever the render costs, so the gain grows with the render: 3 times the requests a second for a render of 2 ms, 36 times for one of 25 ms. The first request for a page still pays for the render (and with `swr` a visitor never waits for the one that refreshes it).

On Cloudflare the same policy is answered from the colo's memory, then the Cache API, then KV; on Vercel it becomes `Vercel-CDN-Cache-Control` and the CDN answers before the function starts. Those tiers add network distance this page does not measure; the live suites in `e2e/` verify them on real accounts.

## What to keep in mind

- One process, one request at a time, no network. A deployment adds TLS, the platform's own routing and the distance to the visitor to every row equally.
- The page and the render are synthetic: the render is a loop that burns the stated time. What a real render costs is the first column; find yours there.
- No other tool is measured. Hypdriv is a sidecar for an application that already has a framework and a platform; the comparison that decides is the application with and without it, which is what these tables are.
- The pipeline's cost depends on what is turned on. These are the defaults; HTML transforms, bot checks and a remote rate-limit store each add their own.
