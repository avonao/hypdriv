# Security

Hypdriv's security stages are on by default with conservative settings. This guide explains what each does, how to tune it, and what it cannot do.

## Content Security Policy

Strict CSP (no host allow-lists for scripts, nonces or hashes only) has always been at odds with static rendering: nonces need per-request rendering, hashes break when content changes. Hypdriv resolves this per route (ADR 0006):

| Route class | On the Worker | On Node (`proxy.ts`) |
| --- | --- | --- |
| `static` (immutable) | hash mode: hashes from the build manifest, response stays cacheable | hash mode |
| `isr`, `shell` (cached but changing) | nonce mode with **edge nonce injection** (`HTMLRewriter` adds the nonce to every `<script>`) | `'self' 'unsafe-inline'` fallback, flagged as `x-hypdriv-csp: unsafe-inline-fallback` |
| `dynamic` | nonce mode (Next.js applies the nonce it receives in the request CSP header) | nonce mode |
| Route Handlers / RSC | no CSP needed; `Reporting-Endpoints` still set | same |

Default directives: `default-src 'self'`, `base-uri 'self'`, `object-src 'none'`, `frame-ancestors 'self'`, `form-action 'self'`, `img-src 'self' data: blob:`, `font-src 'self' data:`, `connect-src 'self'`, `worker-src 'self' blob:`, `style-src 'self' 'unsafe-inline'` (React emits inline style attributes), `upgrade-insecure-requests` in production, `'unsafe-eval'` only in development (Turbopack HMR).

Allow third parties with shorthands rather than rewriting directives:

```ts
security: { csp: { allow: { scripts: ['https://js.stripe.com'], frames: ['https://js.stripe.com'], connect: ['https://api.stripe.com'], images: ['https://*.cloudinary.com'] } } }
```

Roll out safely: `reportOnly: true` first, read violations with `hypdriv csp suggest` (it aggregates `/_hypdriv/csp-report` submissions into allow-list proposals), then switch to enforcement. `reportOnly: 'both'` enforces the current policy and reports a stricter one.

Third-party scripts you render yourself need the nonce on dynamic routes:

```tsx
import { nonce } from 'hypdriv/server';
export default async function Analytics() {
  const n = await nonce();
  return <script nonce={n} src="https://js.stripe.com/v3/" />;
}
```

On static routes the inline scripts Next.js emits are hashed at build time; any inline script *you* add to a static page must be static too (same text on every build), or move it to an external file served from `'self'`.

## Security headers

The preset scores A+ on securityheaders.com: HSTS (2 years, `includeSubDomains`; add `preload: true` once every subdomain is https), `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying sensors, camera, microphone, geolocation, payment (allow with `permissionsPolicy: { camera: ['self'] }`), `Cross-Origin-Opener-Policy: same-origin-allow-popups`, `Cross-Origin-Resource-Policy: same-site`, `X-Frame-Options: DENY` (mirrors `frame-ancestors`), `Origin-Agent-Cluster`. COEP is off by default because it breaks third-party embeds that lack CORP headers; enable `coep: 'credentialless'` when you need `SharedArrayBuffer`.

Headers the application sets itself are preserved; Hypdriv only fills gaps (and removes `X-Powered-By`).

## Rate limiting

```ts
security: {
  rateLimit: [
    { id: 'api', match: '/api/**', limit: 120, window: '1m', key: ['ip'] },
    { id: 'login', match: '/api/auth/login', methods: ['POST'], limit: 5, window: '10m', algorithm: 'token-bucket', burst: 2, key: ['ip', 'path'] },
    { id: 'tenant', match: '/api/**', limit: 10000, window: '1h', key: ['api-key'], store: 'durable-object' },
  ],
}
```

Stores: memory (per isolate), Cache API (per colo, approximate, zero config — the default on Workers), KV, `HypDrivLimiter` Durable Object (exact and global), Cloudflare Rate Limiting binding (per colo, 10 s / 60 s windows, very cheap). Responses carry IETF `RateLimit`/`RateLimit-Policy` headers and `Retry-After`; limited requests get a JSON 429 (customisable with `response`). In `safeAction()` and `defineRoute()` you can add per-handler limits keyed by user or session.

## Bot shield

Verdicts: `human`, `verified` (Cloudflare verified bots or known search/social crawlers), `likely` (Bot Management score under the threshold, missing/odd headers), `definite` (headless/automation user agents, honeypot paths, blocked agents). Policies per verdict: `allow`, `log`, `challenge` (Turnstile page, then allow), `block` (403), `tarpit` (delay then 429). Defaults: verified → allow, likely → log, definite → block. Exempt patterns default to Next internals, Hypdriv internals and `/api/webhooks/**`.

`request.cf.botManagement` is used when your plan provides it; otherwise heuristics only. For `challenge` you need a Turnstile site key and secret. Site keys usually differ per environment (and Cloudflare's always-pass test keys are handy in CI), so read both from the environment instead of hard-coding the key:

```ts
security: {
  bots: {
    likelyAutomated: 'challenge',
    turnstile: { siteKeyEnv: 'TURNSTILE_SITE_KEY', secretEnv: 'TURNSTILE_SECRET_KEY', action: 'login' },
  },
},
```

`siteKeyEnv` defaults to `TURNSTILE_SITE_KEY` when no literal `siteKey` is configured. Switching keys is a secret change (`wrangler secret bulk`), not a redeploy. A passed challenge sets an `HttpOnly`, `Secure`, `SameSite=Lax` clearance cookie (`hyp_clearance`, 30 minutes by default); the challenge page's CSP allows `challenges.cloudflare.com`.

## Shield (WAF-lite)

Method allow-list (405), URL length (414), encoded traversal and null bytes (400), hidden/backup paths that always 404 (`.env*`, `.git/**`, `*.bak`, `*.sql`, keys), request body size per route (413; `1mb` for `/api/**`, `10mb` elsewhere), optional host enforcement (421).

## Server Actions and Route Handlers

```ts
'use server';
import { safeAction } from 'hypdriv/server';
import { z } from 'zod';

export const createPost = safeAction({
  input: z.object({ title: z.string().min(3), body: z.string() }),
  auth: async (ctx) => getUser(ctx.headers),            // null → UNAUTHORIZED
  rateLimit: { key: (ctx) => ctx.auth?.id ?? ctx.ip, limit: 20, window: '1m' },
  idempotency: { store: kvIdempotency, ttlSeconds: 600 }, // replay-safe form submissions
  turnstile: { secret: process.env.TURNSTILE_SECRET_KEY! },
  async handler(input, ctx) { return db.posts.insert({ ...input, author: ctx.auth.id }); },
});
```

Results are `{ ok: true, data }` or `{ ok: false, error: { code, message, fieldErrors } }`; `redirect()`/`notFound()` still work. Any [Standard Schema](https://standardschema.dev) library (Zod 4, Valibot, ArkType) validates input. `defineRoute()` offers the same for Route Handlers plus query/body parsing, CORS preflight, weak ETags with `304` and cache headers.

Remember Next's guidance: Server Functions are POST requests to the page's route, so a proxy matcher that excludes a path also excludes its actions. Authorise inside every action; Hypdriv's stages are defence in depth, not the authorisation layer.

## Sessions, tokens and crypto

- `createSessionStore({ secret: [current, previous] })`: AES-256-GCM cookies with HKDF-derived keys and key ids, sliding expiry, rotation without logout.
- `jwt.sign/verify`: HS256, ES256, RS256; JWKS URLs with caching; strict claim validation; `alg: none` rejected.
- `signing.signUrl/verifyUrl` for expiring links; `signing.signInternalRequest/verifyInternalRequest` for the job dispatchers.
- `webhooks.verifyStripe/verifyGitHub/verifyStandard` with replay windows.
- `passwords.hash/verify` (scrypt on Node/Workers with `nodejs_compat`, PBKDF2-SHA-256 fallback, PHC strings).
- `safeRedirect(target, { origin })` prevents open redirects in `redirect()` calls.

All WebCrypto; no Node-only dependencies at runtime.

## Build-time checks

- **Secrets scan**: client assets (`.next/static`, `public`) are scanned for credential formats (AWS, Stripe, GitHub, Slack, OpenAI, Anthropic, Cloudflare, database URLs, private keys, JWTs…) and for values of non-public environment variables. Findings fail the build (`secretsScan.failOnFinding`).
- **SRI**: `security.sri: true` turns on Turbopack's Subresource Integrity for scripts.
- **CSP hashes** for static routes come from the prerendered HTML; the Worker also validates at runtime that a static route's HTML hash set matches the manifest build id.

## What Hypdriv does not replace

Authentication and authorisation, input validation inside your handlers, dependency hygiene, database security and Cloudflare's own WAF/DDoS layers. Hypdriv raises the floor; it is not the ceiling.
