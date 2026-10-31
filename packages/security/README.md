# @hypdriv/security

Security primitives for Hypdriv, the Hyper-Extension for Next.js 16+ on Cloudflare Workers: CSP autopilot, an A+ security-header preset, rate limiting, a bot shield, WAF-lite request shielding, CSRF, `safeAction()` / `defineRoute()`, encrypted sessions, JWT, signing, webhook verification, password hashing, an open-redirect guard and a build-time secrets scan.

Everything in the main entry is built on web standards (`fetch`, `Request`/`Response`, WebCrypto) and runs unchanged on Cloudflare Workers, Node (`next start`, `proxy.ts`) and Vercel. Node APIs live only in `@hypdriv/security/node`. The package has zero runtime dependencies besides `@hypdriv/core`.

```sh
pnpm add @hypdriv/security
```

Most applications never import this package directly: `@hypdriv/cloudflare` (`createWorker`) and `@hypdriv/next` (`createProxy`, `hyp()`, `withHypDriv`) wire the stages and helpers from `hypdriv.config.ts`. Import it when you need the primitives in application code (actions, routes, sessions, JWTs, webhooks) or when composing a custom stage list.

## Contents

- [Pipeline stages](#pipeline-stages)
- [CSP autopilot](#csp-autopilot)
- [Security headers](#security-headers)
- [Rate limiting](#rate-limiting)
- [Bot shield and Turnstile](#bot-shield-and-turnstile)
- [Shield (WAF-lite) and CSRF](#shield-waf-lite-and-csrf)
- [`safeAction()`](#safeaction)
- [`defineRoute()`](#defineroute)
- [Sessions and encryption](#sessions-and-encryption)
- [JWT](#jwt)
- [Signing](#signing)
- [Webhooks](#webhooks)
- [Passwords](#passwords)
- [Open-redirect guard and device class](#open-redirect-guard-and-device-class)
- [Secrets scan (Node)](#secrets-scan-node)
- [Threat-model notes](#threat-model-notes)
- [Workers vs Node](#workers-vs-node)

## Pipeline stages

Each stage is a `Stage` from `@hypdriv/core` (`{ name, pre?, post? }`) and reads its settings from the resolved configuration. They are listed here in the default pipeline order.

| Factory | Stage name | pre | post | State key |
| --- | --- | --- | --- | --- |
| `shieldStage(config)` | `shield` | method / URL / traversal / blocked paths / host / body size (runs on `/_next/*` too) | — | — |
| `botsStage(config, options?)` | `bots` | classify, apply policy (allow / log / block / tarpit / challenge), `x-hypdriv-bot` request header | — | `BOT_KEY` |
| `rateLimitStage(config, limiter)` | `rate-limit` | evaluate matching policies, `429` on the first denial | `RateLimit*` headers of the most constrained policy | `RATE_LIMIT_KEY` |
| `csrfStage(config)` | `csrf` | double-submit / `Sec-Fetch-Site` check for unsafe methods | — | — |
| `cspStage(config, options?)` | `csp` | pick mode, generate the nonce, forward it to Next.js | response policy, edge nonce injection, `x-hypdriv-csp` | `NONCE_KEY`, `CSP_MODE_KEY` |
| `securityHeadersStage(config)` | `security-headers` | — | header preset, fingerprint removal (runs on `/_next/*` too) | — |

State keys are typed `StateKey`s for `ctx.state`: `NONCE_KEY` (`string`), `CSP_MODE_KEY` (`'nonce' | 'hash' | 'report-only' | 'off' | 'unsafe-inline-fallback'`), `CSP_EXTRA_HASHES_KEY` (`string[]`, filled by stages that inject deterministic inline scripts at the edge), `RATE_LIMIT_KEY` (`{ policy, remaining, limit, reset }[]`, `reset` in epoch ms) and `BOT_KEY` (`{ verdict, score?, reason }`).

## CSP autopilot

Strict CSP without per-page work (ADR 0006):

- **Hash mode** for immutable `static` routes whose inline script hashes were computed at build time (`manifest.csp[routeId]`). The policy is `script-src 'self' 'sha256-…' … 'unsafe-inline'` and travels as a response header only, so the HTML stays cacheable. `'strict-dynamic'` is deliberately **not** emitted in hash mode: prerendered HTML contains parser-inserted `<script src>` tags without a nonce that `'strict-dynamic'` would block. `'unsafe-inline'` is the CSP1 fallback; browsers that understand hashes ignore it.
- **Nonce mode** for everything else (dynamic, `shell`, `isr`, RSC requests, no manifest): `script-src 'self' 'nonce-…' 'strict-dynamic'`. The nonce is generated per request and delivered to Next.js through the request headers `x-nonce` (configurable) and `content-security-policy`, which is where Next.js reads it from.
- **Edge nonce injection**: on Workers the `post` phase rewrites HTML with `HTMLRewriter`, adding the nonce to every `<script>` that lacks one (and to `<style>`/`<link rel=stylesheet>` when `unsafeInlineStyles` is off). Cached or ISR HTML that Next.js did not render for this request therefore matches the header; Next-rendered HTML already carries the nonce, so the transform is a no-op there. Control it with `cspStage(config, { edgeNonceInjection: 'auto' | 'always' | 'never' })`.
- **Non-edge fallback**: without `HTMLRewriter` (`proxy.ts` on Node), `isr` and `shell` routes cannot be given a nonce, so they fall back to `script-src 'self' 'unsafe-inline'` and are marked `x-hypdriv-csp: unsafe-inline-fallback`. Strict CSP for cached HTML needs the Worker.
- Report-only rollout: `reportOnly: true` emits `Content-Security-Policy-Report-Only`; `'both'` emits the enforced policy plus a stricter report-only copy without `'unsafe-inline'`, which tells you whether `unsafeInlineStyles` can be dropped.
- A policy the application sets itself always wins (`x-hypdriv-csp: app`).

```ts
import { buildCspHeader, cspStage, cspReportHandler, suggestPolicy, parseCsp } from '@hypdriv/security';

// one-off policy string (e.g. for a custom response)
const header = buildCspHeader({ config: config.security.csp!, mode: 'nonce', nonce, development: false });

// collector for /_hypdriv/csp-report (legacy csp-report, Reporting API arrays and plain JSON)
const collect = cspReportHandler({ sink: (report) => analytics.write(report), maxBytes: 64 * 1024 });

// turn violations into a proposal (`hypdriv csp suggest` uses this)
const { additions, directives } = suggestPolicy(reports, parseCsp(currentHeader));
```

`buildCspHeader` applies `allow.*` shorthands, adds `'unsafe-eval'` and the HMR websocket origin only in development, `report-uri` + `report-to hypdriv` when a collector is configured, `upgrade-insecure-requests` outside development and Trusted Types directives when enabled. Hashes may be passed quoted (`'sha256-…'`) or bare; they are never double-quoted. Directives serialise deterministically: `default-src` first, then alphabetical.

## Security headers

`buildSecurityHeaders(config.security.headers, { development, https, pathname })` returns the preset that scores A+ on securityheaders.com:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains   (https only, never in development)
Cross-Origin-Opener-Policy: same-origin-allow-popups
Cross-Origin-Resource-Policy: same-site
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: accelerometer=(), …, fullscreen=(self), …   (deny by default, allow-list per feature)
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
X-DNS-Prefetch-Control: on
X-Permitted-Cross-Domain-Policies: none
Origin-Agent-Cluster: ?1
```

`securityHeadersStage` applies it in `post` without clobbering headers the application set, removes `X-Powered-By` and `Server` when `stripFingerprints` is on (`x-opennext` is kept) and runs on `/_next/static` so assets get `nosniff` and CORP too. Per-route overrides (`routes: [{ match, headers }]`) merge over the base; `serializePermissionsPolicy` renders `feature=(self "https://x")` lists.

## Rate limiting

Algorithms: `fixed-window`, `sliding-window` (two-window weighted approximation `prev × (1 − elapsed/window) + current`) and `token-bucket` (capacity `limit + burst`, refill `limit / window` per second). Counters live in a `CounterStore`:

| Store | Scope | Accuracy |
| --- | --- | --- |
| `createMemoryCounterStore()` | per isolate / process | exact within the isolate |
| `createCacheApiCounterStore()` | per Cloudflare colo, zero config | approximate: read-modify-write without locking may undercount under concurrency; entries may be evicted early |
| `createKvCounterStore(kv)` | global | approximate: eventually consistent (~60 s), 60 s minimum TTL; good for coarse limits |
| `HypDrivLimiter` Durable Object (`@hypdriv/cloudflare`) | global | exact |
| Rate Limiting binding (`store: 'binding'`) | per colo | exact, but `remaining` is unknown (reported as `1`/`0`) |

Stores implement `increment` and optionally `slidingCount` / `takeToken`; the limiter emulates the missing ones on top of `increment`. Store failures fail **open** by default (`failOpen: false` to change that).

```ts
import { createRateLimiter, createMemoryCounterStore, rateLimitHeaders, rateLimitStage } from '@hypdriv/security';

const limiter = createRateLimiter({ store: createMemoryCounterStore(), binding: env.HYPDRIV_RATE_LIMIT });
const stage = rateLimitStage(config, limiter);
const result = await limiter.check(policy, 'login|ip=203.0.113.7');
rateLimitHeaders(result, 'login');
// RateLimit: "login";r=4;t=37      RateLimit-Policy: "login";q=5;w=60
// X-RateLimit-Limit/Remaining/Reset  Retry-After (when limited)
```

`resolveRateLimitKey(policy, ctx)` joins the policy id with each configured dimension: `ip`, `session` (cookie, hashed), `user` (header), `api-key` (header, hashed), `path`, `global`.

## Bot shield and Turnstile

`classifyRequest(ctx, config)` returns `{ verdict, score?, reason }` with verdicts `human`, `verified`, `likely`, `definite`:

- `verified`: Cloudflare Bot Management (`cf.botManagement.verifiedBot`, `cf.verifiedBotCategory`) or the built-in search/social crawler list (Googlebot, Bingbot, DuckDuckBot, Applebot, YandexBot, Baiduspider, facebookexternalhit, Twitterbot, LinkedInBot, Slackbot, Discordbot, WhatsApp, TelegramBot, Pinterestbot). When Bot Management says `verifiedBot: false`, a crawler user agent is treated as spoofed (`likely`).
- `definite`: `blockUserAgents`, honeypot paths, Bot Management score < 2, empty user agent on a document request, automation tokens (`HeadlessChrome`, `PhantomJS`, `python-requests`, `curl`, `wget`, `Go-http-client`, `scrapy`, `node-fetch`, `axios`, `okhttp`, security scanners) on **document** requests.
- `likely`: SEO/AI crawlers (Ahrefs, Semrush, GPTBot, ClaudeBot, …), score below `scoreThreshold`, browser user agents without `Accept`/`Accept-Language`, `Sec-Fetch-*` inconsistencies (including modern Chrome/Firefox navigations without them), and automation tokens on **API-style** requests, so mobile apps (`okhttp`) and CLI clients keep working under the default `log` policy.

`botsStage` applies the per-verdict policy: `allow`, `log`, `block` (403 JSON), `tarpit` (sleep, then 429) or `challenge`. Challenges render a minimal Turnstile page (`turnstile: { siteKey }`); a solved widget posts the token back, the stage verifies it with `verifyTurnstile(secret, token, ip)` (secret from `turnstile.secretEnv`, default `TURNSTILE_SECRET_KEY`) and sets a signed `hyp_clearance` cookie (30 minutes, bound to the user agent, signed with the session secret) so the visitor is not challenged on every request. Form posts carrying `cf-turnstile-response` are verified inline.

## Shield (WAF-lite) and CSRF

`shieldStage` rejects before Next.js runs: disallowed methods (405 + `Allow`), URLs over `maxUrlLength` (414), encoded traversal / null bytes / backslashes (400), hidden and backup paths such as `/.env`, `/.git/**`, `*.sql`, `*.pem` (404), hosts outside `enforceHost` / `site.origin` (421) and declared bodies over the matching `maxBody` limit (413). A missing `Host` header falls back to the request URL's authority, because Fetch-API `Request`s never carry one. Bodies without `Content-Length` cannot be sized at this layer; enforce limits in handlers (`defineRoute` has `maxBodyBytes`).

`csrfStage` protects unsafe methods on `csrf.match` routes (default `/api/**`, webhooks exempt). A request passes with a same-origin `Sec-Fetch-Site` (`same-origin` / `none`) or a double-submit token: the `hyp_csrf` cookie must equal the `x-csrf-token` header (or `_csrf` form field) and, when the session secret is available, verify as an HMAC token from `issueCsrfToken(secret, sessionId?)`.

```ts
const token = await issueCsrfToken(process.env.HYPDRIV_SESSION_SECRET!, session.id); // "<id>.<sig>"
// set it as the hyp_csrf cookie and render it into the form / fetch header
```

## `safeAction()`

Wraps a Server Action with Standard Schema validation (Zod 3.24+, Valibot, ArkType, Effect Schema, …), Turnstile, auth, guards, rate limiting, idempotency and audit hooks. It never throws for expected failures and rethrows Next.js navigation errors (`redirect()`, `notFound()`, `forbidden()`), so they keep working.

```ts
'use server';
import { safeAction, ActionError } from '@hypdriv/security';
import { z } from 'zod';

export const createPost = safeAction({
  name: 'createPost',
  input: z.object({ title: z.string().min(3), body: z.string() }),
  auth: async (ctx) => getUser(ctx.headers),            // null → UNAUTHORIZED
  guards: [(ctx) => ctx.auth.role === 'editor'],         // false → FORBIDDEN
  rateLimit: { key: (ctx) => ctx.auth.id, limit: 20, window: '1m' },
  turnstile: { secret: process.env.TURNSTILE_SECRET_KEY! },
  idempotency: { store: createKvIdempotencyStore(env.HYPDRIV_KV), ttlSeconds: 86400 },
  audit: (event) => log.info('action', event),
  handler: async (input, ctx) => {
    if (await slugTaken(input.title)) throw new ActionError('CONFLICT', 'Title in use', { fieldErrors: { title: ['taken'] } });
    return db.posts.create({ ...input, authorId: ctx.auth.id });
  },
});

// client / form
const result = await createPost(formData);           // { ok: true, data } | { ok: false, error: { code, message, fieldErrors? } }
const [state, action] = useActionState(createPost, null); // (prevState, formData) is accepted too
```

Error codes: `VALIDATION` (field errors keyed by dotted path, `_form` for path-less issues), `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED` (with `retryAfter`), `CHALLENGE_FAILED`, `CONFLICT`, `INTERNAL` (message hidden; original error passed to `onError`). Idempotency keys come from the call option, `idempotency.key(ctx)` or the `Idempotency-Key` header; a reused key with a different payload is a `CONFLICT`, an in-flight duplicate is a `CONFLICT`, and failures release the key so the client can retry. The request context (`requestId`, `ip`, `headers`) comes from `getContext` or the global `globalThis.__hypdriv_action_context__` (an object or a function), which `@hypdriv/next` fills from `next/headers`.

## `defineRoute()`

The same guarantees for Route Handlers, returned as a fetch-style function you can export directly:

```ts
// app/api/posts/[id]/route.ts
import { defineRoute } from '@hypdriv/security';

export const GET = defineRoute({
  method: 'GET',
  query: z.object({ fields: z.array(z.string()).optional() }),  // repeated keys become arrays
  auth: (ctx) => getUser(ctx.headers),
  rateLimit: { limit: 100, window: '1m' },                        // keyed by client IP unless `key` is given
  cache: { maxAge: 60, swr: 600 },                                // public, max-age=60, stale-while-revalidate=600
  cors: { origins: ['https://app.example.com'], credentials: true },
  handler: async (ctx) => db.posts.get(ctx.params.id),            // JSON + weak ETag + 304 on If-None-Match
});
```

Bodies are parsed by content type (JSON, form data, text) and validated with the `body` schema; `ActionError`s become `application/problem+json` (`{ type, title, status, detail, code, errors? }`); wrong methods get `405` with `Allow`; `OPTIONS` preflights are answered when `cors` is set; `Response` results pass through untouched.

## Sessions and encryption

```ts
import { createSessionStore, encrypt, decrypt } from '@hypdriv/security';

const sessions = createSessionStore<{ userId: string }>({
  secret: [process.env.HYPDRIV_SESSION_SECRET!, process.env.HYPDRIV_SESSION_SECRET_PREVIOUS!],
  ttlSeconds: 7 * 86400,
});
const { data, needsRefresh } = await sessions.read(request.headers);
headers.append('set-cookie', await sessions.write({ userId: 'u1' }));
headers.append('set-cookie', sessions.clear());
```

`encrypt(secret, plaintext, aad?)` is AES-256-GCM under a key derived with HKDF-SHA256 (`info = hypdriv/v1/<kid>`, `kid` = first 8 hex of `sha256(secret)`), producing `v1.<kid>.<iv>.<ciphertext+tag>` in base64url. `decrypt([current, previous], token)` picks the secret by `kid`, which makes rotation a configuration change: sessions encrypted with the previous secret stay readable and report `needsRefresh` so they are re-written with the current one. The cookie name is bound in as AAD; cookies above 4000 bytes throw `HypDrivError E_CRYPTO` with a hint to keep sessions small.

## JWT

```ts
import { jwt } from '@hypdriv/security';

const token = await jwt.sign({ sub: 'u1' }, process.env.JWT_SECRET!, { alg: 'HS256', expiresIn: 3600, issuer: 'api' });
const { payload } = await jwt.verify(token, process.env.JWT_SECRET!, { issuer: 'api' });
await jwt.verify(idToken, { jwksUrl: 'https://issuer.example.com/.well-known/jwks.json' }, { audience: 'client-id' });
```

HS256 (shared secret, 32+ characters), ES256 (P-256, raw `r||s` signatures) and RS256 keys as strings (secret / PEM SPKI or PKCS#8), `CryptoKey`s, JWK arrays or `{ jwksUrl }` with a 10-minute in-memory cache that refetches once on an unknown `kid`. `alg: none` is rejected, algorithms are allow-listed, and key confusion is impossible by construction: a shared secret only verifies HS256, asymmetric keys only their own algorithm. Claims checked: `exp`, `nbf`, `iat` (with `clockTolerance`), `iss`, `aud`, `sub`, `maxTokenAge`. Failures throw `JwtError` (`status` 401, `reason` such as `expired`, `invalid-signature`, `unknown-kid`).

## Signing

- `signUrl(url, secret, { expiresIn })` / `verifyUrl`: HMAC over pathname + sorted query (host-agnostic so preview hosts share links), with an `exp` parameter.
- `signValue(value, secret)` / `verifyValue`: `<value>.<sig>` for cookies and tokens.
- `signInternalRequest(request, secret)` / `verifyInternalRequest(request, secret, { ttlSeconds })`: `x-hypdriv-timestamp` + `x-hypdriv-signature = HMAC(timestamp, method, pathname, search, sha256(body))`, constant-time comparison, 5-minute replay window. Used by the Worker's `scheduled` / `queue` dispatchers to call Route Handlers.

## Webhooks

`webhooks.verifyStripe(rawBody, header, secret, tolerance?)`, `webhooks.verifyGitHub(rawBody, 'sha256=…', secret)` and `webhooks.verifyStandard(rawBody, { id, timestamp, signature }, 'whsec_…', tolerance?)` (Standard Webhooks / Svix). Always pass the raw request body text; re-serialised JSON breaks signatures.

## Passwords

`passwords.hash(password)` produces PHC strings: scrypt (`$scrypt$ln=15,r=8,p=1$…`) when `node:crypto` is available (Node, Bun, workerd with `nodejs_compat`), otherwise PBKDF2-SHA256 with 600 000 iterations (`$pbkdf2-sha256$i=600000$…`). `passwords.verify` accepts both; a pure-JavaScript scrypt (RFC 7914, tested against its vectors) verifies scrypt hashes on runtimes without `node:crypto`. `passwords.needsRehash(phc)` reports hashes below the current parameters so you can upgrade them at login. Passwords are NFKC-normalised before hashing.

## Open-redirect guard and device class

`safeRedirect(target, { origin, allowHosts, fallback })` accepts relative paths starting with a single `/` (rejecting `//host`, `/\host`, backslashes and control characters) and absolute `http(s)` URLs on the same origin or an allow-listed host (`*.example.com`); everything else returns the fallback (`/`). `deviceClass(headers)` → `mobile | desktop | bot` from `Sec-CH-UA-Mobile` / `Sec-CH-UA-Platform` and user-agent heuristics (used by cache variance and flags).

## Secrets scan (Node)

```ts
import { scanSecrets, formatFindings } from '@hypdriv/security/node';

const findings = await scanSecrets({ dirs: ['.open-next/assets', '.next/static'], env: process.env, publicPrefixes: ['NEXT_PUBLIC_'] });
console.log(formatFindings(findings));
```

Walks build output (`.js .mjs .cjs .css .html .json .txt .map .webmanifest`), skipping binaries, symlinks and files above 10 MiB, and reports known key formats (AWS, Stripe, GitHub, Slack, OpenAI, Anthropic, Cloudflare, private keys, JWTs, database URLs, …) plus the values of non-public environment variables (length ≥ 12, not paths, URLs, numbers or plain words) with file, line, column and a redacted snippet. The adapter runs it after `next build` when `security.secretsScan` is on.

## Threat-model notes

- **CSP** blocks injected inline scripts and unapproved script origins; it does not sanitise your HTML. Hash mode covers only the inline scripts present at build time, so the `csp` stage falls back to nonce mode whenever a route is not fully static. Report-only first, then enforce.
- **User-agent based bot verification is spoofable.** Without Cloudflare Bot Management, "verified" means the user agent claims to be a known crawler. Keep `verified: 'allow'` (default) but never grant privileges on it; use Bot Management or Turnstile when it matters.
- **Rate limits** are approximate on the zero-config stores and per isolate / per colo. They are an abuse brake, not an accounting system. Use the Durable Object limiter or the Rate Limiting binding when exactness matters, and prefer `session` / `user` keys over `ip` behind carrier NAT.
- **Clearance and CSRF cookies** are HMAC-signed with the session secret; rotate it like any credential. Clearance is bound to the user agent, not the IP, so mobile users keep it across networks.
- **Sessions** are encrypted and authenticated, but the cookie is still a bearer token: use `Secure`, `HttpOnly`, `SameSite=Lax` (defaults) and short TTLs for sensitive roles; store ids and roles, not profiles.
- **`safeAction` hides internal error messages** from clients (`INTERNAL` → "Something went wrong"); route the original error to `onError` and your logger. Validation messages come from your schema and are shown to users.
- **Open redirects**: `safeRedirect` whitelists, it does not blacklist. Allow-list hosts explicitly rather than trying to enumerate bad ones.

## Workers vs Node

| Capability | Cloudflare Workers | Node (`next start`, `proxy.ts`) |
| --- | --- | --- |
| Edge nonce injection for cached HTML | yes (`HTMLRewriter`) | no: `isr`/`shell` routes use the `unsafe-inline` fallback |
| Counter stores | memory (per isolate), Cache API, KV, Durable Object, Rate Limiting binding | memory (per process); bring your own store for multi-instance deployments |
| Bot Management signals (`cf.botManagement`) | yes on zones with Bot Management | heuristics only |
| Password hashing | scrypt with `nodejs_compat`, else PBKDF2-SHA256; pure-JS scrypt for verification | scrypt via `node:crypto` |
| `@hypdriv/security/node` (secrets scan) | not available (build-time tool) | yes |

Everything else (CSP building, headers, JWT, signing, sessions, webhooks, `safeAction`, `defineRoute`) behaves identically on both.

## License

MIT
