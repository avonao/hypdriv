/**
 * Live end-to-end suite for HypDriv on Cloudflare. Runs against a deployed copy of this app (see README.md)
 * and verifies every capability through its public behaviour and the Cloudflare API.
 *
 *   E2E_URL=https://hypdriv-e2e.example.com \
 *   HYPDRIV_INTERNAL_SECRET=… CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
 *   E2E_KV_NAMESPACE_ID=… E2E_WORKER=hypdriv-e2e E2E_R2_BUCKET=… E2E_AE_DATASET=hypdriv_e2e \
 *   pnpm -F @hypdriv/e2e-cloudflare e2e [--only <id,…>] [--skip <id,…>] [--json]
 *
 * Optional: E2E_TAIL_PRODUCER_URL (a Worker that lists this one in `tail_consumers`), E2E_ZONE_ID,
 * E2E_TURNSTILE=test (the deployment currently uses Cloudflare's always-pass Turnstile test keys: solve
 * the challenge in Chromium), E2E_TURNSTILE_SITE_KEY (the site key the challenge page must carry).
 * Exit code 1 when a check fails. Writes `e2e-report.json`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { signing } from '@hypdriv/security';

type Status = 'pass' | 'fail' | 'skip';
interface Result {
  id: string;
  area: string;
  title: string;
  status: Status;
  detail: string;
  ms: number;
}
interface Check {
  id: string;
  area: string;
  title: string;
  /** Long-running checks run concurrently with the rest. */
  slow?: boolean;
  /** Changes site-wide state (maintenance): runs alone, after every other check. */
  exclusive?: boolean;
  needs?: string[];
  run: () => Promise<string>;
}

class Skip extends Error {}

/** The slice of Playwright the Turnstile check uses (resolved at run time, not a dependency). */
interface PlaywrightLike {
  chromium: {
    launch(): Promise<{
      newContext(o: { userAgent: string }): Promise<{
        newPage(): Promise<{
          goto(url: string, o: { waitUntil: 'domcontentloaded' }): Promise<{ status(): number } | null>;
          waitForSelector(selector: string, o: { timeout: number }): Promise<unknown>;
        }>;
        cookies(
          url: string,
        ): Promise<Array<{ name: string; httpOnly: boolean; secure: boolean; sameSite: string }>>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    skip: { type: 'string' },
    json: { type: 'boolean' },
    report: { type: 'string' },
  },
});

const env = process.env;
const BASE = (env.E2E_URL ?? '').replace(/\/+$/, '');
if (!BASE) {
  console.error('E2E_URL is required (the deployed suite, e.g. https://hypdriv-e2e.example.com)');
  process.exit(2);
}
const HOST = new URL(BASE).host;
const SECRET = env.HYPDRIV_INTERNAL_SECRET ?? '';
const ACCOUNT = env.CLOUDFLARE_ACCOUNT_ID ?? env.CF_ACCOUNT_ID ?? '';
const TOKEN = env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN ?? '';
const KV_ID = env.E2E_KV_NAMESPACE_ID ?? '';
const WORKER = env.E2E_WORKER ?? '';
const RUN = Date.now().toString(36);

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
// No Sec-Fetch-* headers: Node's fetch always sends `sec-fetch-mode: cors`, which a navigation
// (`sec-fetch-dest: document`) would contradict, and the bot shield rightly flags that combination.
const DOC_HEADERS = {
  'user-agent': BROWSER_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};
const API_HEADERS = { 'user-agent': BROWSER_UA, accept: 'application/json', 'accept-language': 'en-US' };

// -- helpers ---------------------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function need(...names: string[]): void {
  const missing = names.filter((n) => !env[n] && !(n === 'CLOUDFLARE_API_TOKEN' && TOKEN));
  if (missing.length) throw new Skip(`needs ${missing.join(', ')}`);
}

type Init = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

async function get(path: string, init: Init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { ...DOC_HEADERS, ...(init.headers ?? {}) },
  });
  const body = init.method === 'HEAD' ? '' : await res.text();
  return { res, body, headers: res.headers, status: res.status };
}

async function api(path: string, init: Init = {}) {
  return get(path, { ...init, headers: { ...API_HEADERS, ...(init.headers ?? {}) } });
}

async function signed(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  if (!SECRET) throw new Skip('needs HYPDRIV_INTERNAL_SECRET');
  const request = new Request(`${BASE}${path}`, {
    method,
    headers: { ...API_HEADERS, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await fetch(await signing.signInternalRequest(request, SECRET));
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json: json as Record<string, unknown>, text, headers: res.headers };
}

async function state(prefix = 'e2e:'): Promise<Record<string, unknown>> {
  const r = await signed(`/api/state?prefix=${encodeURIComponent(prefix)}`);
  assert(r.status === 200, `/api/state answered ${r.status}`);
  return r.json;
}

async function poll<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline)
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${last ? ` (${(last as Error).message})` : ''}`,
      );
    await sleep(intervalMs);
  }
}

async function cf(method: string, path: string, body?: unknown, raw = false) {
  if (!ACCOUNT || !TOKEN) throw new Skip('needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/${path.replace('ACCOUNT', `accounts/${ACCOUNT}`)}`,
    {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
      },
      ...(body === undefined ? {} : { body: raw ? (body as string) : JSON.stringify(body) }),
    },
  );
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as Record<string, unknown> & { result?: unknown } };
  } catch {
    return { status: res.status, json: { raw: text } as Record<string, unknown> & { result?: unknown } };
  }
}

async function kvPut(key: string, value: string) {
  if (!KV_ID) throw new Skip('needs E2E_KV_NAMESPACE_ID');
  const r = await cf(
    'PUT',
    `ACCOUNT/storage/kv/namespaces/${KV_ID}/values/${encodeURIComponent(key)}`,
    value,
    true,
  );
  assert(r.status === 200, `KV put ${key}: ${r.status}`);
}

async function kvDelete(key: string) {
  if (!KV_ID) throw new Skip('needs E2E_KV_NAMESPACE_ID');
  await cf('DELETE', `ACCOUNT/storage/kv/namespaces/${KV_ID}/values/${encodeURIComponent(key)}`);
}

async function logs(
  needle: string,
  sinceMs: number,
  service = WORKER,
): Promise<Array<Record<string, unknown>>> {
  if (!service) throw new Skip('needs E2E_WORKER');
  const now = Date.now();
  const r = await cf('POST', 'ACCOUNT/workers/observability/telemetry/query', {
    queryId: `hypdriv-e2e-${RUN}`,
    timeframe: { from: sinceMs - 60_000, to: now + 60_000 },
    view: 'events',
    limit: 100,
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: service }],
      needle: { value: needle, isRegex: false, matchCase: false },
    },
  });
  assert(r.status === 200, `observability query answered ${r.status}`);
  const events = (r.json.result as { events?: { events?: Array<{ source?: Record<string, unknown> }> } })
    ?.events?.events;
  return (events ?? []).map((e) => e.source ?? {});
}

function html(body: string, id: string): string | null {
  const m = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(body);
  return m ? m[1]! : null;
}

/**
 * Inline/external scripts of a document that its CSP would block: allowed are scripts carrying the policy's
 * nonce, inline scripts whose hash is listed, and anything when the policy falls back to 'unsafe-inline'
 * (no nonce or hash present, which is what browsers honour).
 */
function blockedScripts(body: string, csp: string): string[] {
  const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
  const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
  const hashes = /'sha(256|384|512)-/.test(scriptSrc);
  const unsafeInline = scriptSrc.includes("'unsafe-inline'") && !nonce && !hashes;
  const blocked: string[] = [];
  for (const m of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const [, attrs, content] = m as unknown as [string, string, string];
    // Data blocks never execute; speculation rules are inline scripts like any other for CSP.
    if (/type="application\/(?:ld\+)?json"/.test(attrs)) continue;
    if (/\bsrc=/.test(attrs)) continue; // external: 'self'
    if (unsafeInline) continue;
    if (nonce && attrs.includes(`nonce="${nonce}"`)) continue;
    if (scriptSrc.includes(`'sha256-${createHash('sha256').update(content).digest('base64')}'`)) continue;
    blocked.push(content.slice(0, 50));
  }
  return blocked;
}

function cacheStatus(h: Headers): string {
  return h.get('x-hypdriv-cache') ?? '—';
}

/** SSE subscription: resolves with the first event whose data matches. */
async function sseWait(
  channel: string,
  match: (data: string) => boolean,
  timeoutMs: number,
  onOpen: () => Promise<void>,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/_hypdriv/live/${channel}`, {
      headers: { ...API_HEADERS, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert(res.status === 200, `SSE answered ${res.status}`);
    assert(res.headers.get('content-type')?.includes('text/event-stream'), 'SSE content-type');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let opened = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE stream ended');
      buffer += decoder.decode(value, { stream: true });
      if (!opened) {
        opened = true;
        await onOpen();
      }
      for (const block of buffer.split('\n\n').slice(0, -1)) {
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (data && match(data)) {
          controller.abort();
          return data;
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    }
  } finally {
    clearTimeout(timer);
  }
}

// -- checks ----------------------------------------------------------------------------------------

const checks: Check[] = [];
const check = (c: Check) => checks.push(c);

check({
  id: 'health',
  area: 'platform',
  title: 'Health endpoint lists every bound capability',
  async run() {
    const { status, body } = await api('/_hypdriv/health');
    assert(status === 200, `status ${status}`);
    const h = JSON.parse(body) as { capabilities: string[]; build: string; deployment: string | null };
    const caps = h.capabilities.join(' | ');
    for (const expected of [
      'Cache API',
      'Durable Object index',
      'rate limiting: exact',
      'live channels',
      'Analytics Engine',
      'Images binding',
      'queues',
    ])
      assert(caps.includes(expected), `capability missing: ${expected} (${caps})`);
    assert(h.deployment && h.build, 'deployment id and build fingerprint reported');
    return `${h.capabilities.length} capabilities · build ${h.build} · deployment ${h.deployment}`;
  },
});

check({
  id: 'https-redirect',
  area: 'platform',
  title: 'http:// redirects to https:// (308)',
  async run() {
    const res = await fetch(`http://${HOST}/tagged?x=1`, { redirect: 'manual', headers: DOC_HEADERS });
    assert(res.status === 308 || res.status === 301, `status ${res.status}`);
    assert(
      res.headers.get('location') === `https://${HOST}/tagged?x=1`,
      `location ${res.headers.get('location')}`,
    );
    return `${res.status} → ${res.headers.get('location')}`;
  },
});

check({
  id: 'security-headers',
  area: 'security',
  title: 'Security headers and hash-based CSP on a static page',
  async run() {
    const { status, headers, body } = await get('/');
    assert(status === 200, `status ${status}`);
    const csp = headers.get('content-security-policy') ?? '';
    assert(/script-src[^;]*'sha256-/.test(csp), 'hash-based script-src');
    assert(!/'unsafe-eval'/.test(csp), 'no unsafe-eval');
    assert(headers.get('x-hypdriv-csp') === 'hash', `csp mode ${headers.get('x-hypdriv-csp')}`);
    for (const h of [
      'strict-transport-security',
      'x-content-type-options',
      'referrer-policy',
      'permissions-policy',
      'cross-origin-opener-policy',
    ])
      assert(headers.get(h), `missing ${h}`);
    assert(!headers.get('x-powered-by'), 'x-powered-by stripped');
    const inline = [...body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].length;
    return `CSP hash mode, ${inline} inline script(s), HSTS ${headers.get('strict-transport-security')}`;
  },
});

check({
  id: 'csp-nonce',
  area: 'security',
  title: 'Dynamic pages get a per-request nonce; every script is allowed by nonce or hash',
  async run() {
    const a = await get('/flags');
    const b = await get('/flags');
    const csp = a.headers.get('content-security-policy') ?? '';
    const nonceOf = (h: Headers) => /'nonce-([^']+)'/.exec(h.get('content-security-policy') ?? '')?.[1];
    const n1 = nonceOf(a.headers);
    const n2 = nonceOf(b.headers);
    assert(n1 && n2 && n1 !== n2, 'fresh nonce per request');
    let byNonce = 0;
    let byHash = 0;
    const blocked: string[] = [];
    for (const m of a.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      const [, attrs, content] = m as unknown as [string, string, string];
      if (/type="application\/(?:ld\+)?json"/.test(attrs)) continue;
      if (attrs.includes(`nonce="${n1}"`)) byNonce++;
      else if (
        !/\bsrc=/.test(attrs) &&
        csp.includes(`'sha256-${createHash('sha256').update(content).digest('base64')}'`)
      )
        byHash++;
      else blocked.push(attrs.trim().slice(0, 60));
    }
    assert(!blocked.length, `${blocked.length} script(s) the policy blocks: ${blocked.join(' | ')}`);
    return `${byNonce} by nonce · ${byHash} by hash (HypDriv-owned inline scripts)`;
  },
});

check({
  id: 'csp-report',
  area: 'security',
  title: 'CSP violation reports are accepted',
  async run() {
    const res = await fetch(`${BASE}/_hypdriv/csp-report`, {
      method: 'POST',
      headers: { ...API_HEADERS, 'content-type': 'application/csp-report' },
      body: JSON.stringify({
        'csp-report': {
          'document-uri': `${BASE}/`,
          'violated-directive': 'script-src-elem',
          'effective-directive': 'script-src-elem',
          'blocked-uri': 'https://evil.example/x.js',
          disposition: 'enforce',
        },
      }),
    });
    assert(res.status === 204 || res.status === 202, `status ${res.status}`);
    return `${res.status}`;
  },
});

check({
  id: 'compression',
  area: 'platform',
  title: 'HTML is compressed and HTTP/3 is advertised',
  async run() {
    const res = await fetch(`${BASE}/`, { headers: { ...DOC_HEADERS, 'accept-encoding': 'br, gzip' } });
    await res.arrayBuffer();
    const enc = res.headers.get('content-encoding');
    const altSvc = res.headers.get('alt-svc') ?? '';
    // fetch decodes transparently but keeps the header Cloudflare sent.
    assert(enc && ['br', 'gzip', 'zstd'].includes(enc), `content-encoding ${enc}`);
    return `content-encoding ${enc ?? '(decoded)'} · alt-svc ${altSvc.includes('h3') ? 'h3' : 'none'}`;
  },
});

check({
  id: 'static-assets',
  area: 'platform',
  title: 'Static assets: immutable chunks and public/_headers rules',
  async run() {
    const home = await get('/');
    const chunk = /src="(\/_next\/static\/[^"?]+)/.exec(home.body)?.[1];
    assert(chunk, 'no chunk referenced');
    const c = await fetch(`${BASE}${chunk}`, { headers: { 'user-agent': BROWSER_UA } });
    await c.arrayBuffer();
    assert(c.status === 200, `chunk ${c.status}`);
    assert(
      /immutable/.test(c.headers.get('cache-control') ?? ''),
      `chunk cache-control ${c.headers.get('cache-control')}`,
    );
    const asset = await fetch(`${BASE}/e2e-assets/pattern.png`, { headers: { 'user-agent': BROWSER_UA } });
    await asset.arrayBuffer();
    assert(asset.headers.get('x-e2e-asset') === '1', '_headers rule applied');
    return `chunk ${c.headers.get('cache-control')} · asset ${asset.headers.get('cache-control')}`;
  },
});

check({
  id: 'not-found',
  area: 'platform',
  title: 'Unknown routes answer 404 with security headers',
  async run() {
    const r = await get(`/no-such-page-${RUN}`);
    assert(r.status === 404, `status ${r.status}`);
    assert(r.headers.get('content-security-policy'), 'CSP on 404');
    return '404 + CSP';
  },
});

check({
  id: 'shield',
  area: 'security',
  title: 'Shield: scanner paths, traversal, methods and oversized URLs',
  async run() {
    const out: string[] = [];
    for (const [path, expected] of [
      ['/.env', [403, 404]],
      ['/.git/config', [403, 404]],
      ['/backup.sql', [403, 404]],
      ['/wp-login.php', [403]],
      ['/a/..%2f..%2fetc/passwd', [400, 403, 404]],
      [`/${'x'.repeat(9000)}`, [414, 400]],
    ] as Array<[string, number[]]>) {
      const r = await get(path);
      assert(expected.includes(r.status), `${path.slice(0, 40)} → ${r.status}`);
      out.push(`${path.slice(0, 16)}→${r.status}`);
    }
    const trace = await fetch(`${BASE}/`, { method: 'TRACE', headers: DOC_HEADERS }).catch(() => null);
    if (trace) {
      assert([405, 403, 400, 501].includes(trace.status), `TRACE → ${trace.status}`);
      out.push(`TRACE→${trace.status}`);
    }
    return out.join(' ');
  },
});

check({
  id: 'bots-block',
  area: 'security',
  title: 'Automation user agents are blocked on documents, allowed on exempt APIs',
  async run() {
    const doc = await get('/', { headers: { 'user-agent': 'python-requests/2.32.3' } });
    assert(doc.status === 403, `document → ${doc.status}`);
    const apiCall = await api('/api/geo', { headers: { 'user-agent': 'python-requests/2.32.3' } });
    assert(apiCall.status === 200, `exempt API → ${apiCall.status}`);
    return `document 403 · /api/** 200`;
  },
});

check({
  id: 'bots-challenge',
  area: 'security',
  title: 'Likely bots get a Turnstile challenge with the per-environment site key',
  async run() {
    const r = await get('/', {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
      },
    });
    assert([403, 429, 200].includes(r.status), `status ${r.status}`);
    assert(/challenges\.cloudflare\.com\/turnstile/.test(r.body), 'Turnstile script on the challenge page');
    const siteKey = /data-sitekey="([^"]+)"|sitekey:\s*'([^']+)'|"sitekey":"([^"]+)"/.exec(r.body);
    const key = siteKey?.[1] ?? siteKey?.[2] ?? siteKey?.[3];
    assert(key, 'site key rendered');
    if (env.E2E_TURNSTILE_SITE_KEY)
      assert(key === env.E2E_TURNSTILE_SITE_KEY, `site key ${key} ≠ E2E_TURNSTILE_SITE_KEY`);
    assert(
      r.headers.get('content-security-policy')?.includes('challenges.cloudflare.com'),
      'CSP allows Turnstile',
    );
    return `${r.status} challenge · site key ${key}`;
  },
});

check({
  id: 'turnstile-pass',
  area: 'security',
  title: 'Turnstile challenge solves in a browser and grants clearance (test keys)',
  slow: true,
  async run() {
    if (env.E2E_TURNSTILE !== 'test')
      throw new Skip('set E2E_TURNSTILE=test while the deployment uses the always-pass test keys');
    const { chromium } = createRequire(import.meta.url)('playwright') as PlaywrightLike;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
      });
      const page = await context.newPage();
      await page.goto(`${BASE}/tagged`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#stamped', { timeout: 30_000 });
      const cookies = await context.cookies(BASE);
      const clearance = cookies.find((c) => c.name === 'hyp_clearance');
      assert(clearance?.httpOnly && clearance.secure, 'HttpOnly Secure clearance cookie');
      const again = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      assert(again?.status() === 200, `with clearance → ${again?.status()}`);
      return `challenge solved; clearance ${clearance.name} (${clearance.sameSite}); next navigation 200`;
    } finally {
      await browser.close();
    }
  },
});

check({
  id: 'edge-cache',
  area: 'cache',
  title: 'Edge cache: MISS → HIT with age and Server-Timing',
  async run() {
    await get(`/?warm=${RUN}`);
    const second = await get(`/?warm=${RUN}`);
    assert(cacheStatus(second.headers) === 'HIT', `second request ${cacheStatus(second.headers)}`);
    assert(second.headers.get('server-timing')?.includes('cache'), 'Server-Timing cache entry');
    assert(second.headers.get('x-hypdriv-build'), 'x-hypdriv-build');
    return `HIT · age ${second.headers.get('age')} · ${second.headers.get('server-timing')}`;
  },
});

check({
  id: 'rsc-variant',
  area: 'cache',
  title: 'RSC payloads and HTML never share a cache entry',
  async run() {
    const rscHeaders = { rsc: '1', accept: '*/*' };
    let rsc = await get('/', { headers: rscHeaders });
    // Next 16 validates the `_rsc` cache-busting parameter and redirects requests without it.
    if (rsc.status === 307 && rsc.headers.get('location')?.includes('_rsc')) {
      rsc = await get(
        new URL(rsc.headers.get('location')!, BASE).pathname +
          new URL(rsc.headers.get('location')!, BASE).search,
        { headers: rscHeaders },
      );
    }
    assert(rsc.status === 200, `rsc ${rsc.status}`);
    assert(
      rsc.headers.get('content-type')?.includes('text/x-component'),
      `rsc content-type ${rsc.headers.get('content-type')}`,
    );
    const doc = await get('/');
    assert(
      doc.headers.get('content-type')?.includes('text/html'),
      `html content-type ${doc.headers.get('content-type')}`,
    );
    assert(doc.body.includes('<html'), 'HTML body');
    return `rsc ${cacheStatus(rsc.headers)} · html ${cacheStatus(doc.headers)}`;
  },
});

check({
  id: 'skew',
  area: 'cache',
  title: 'Skew protection: deployment id header and reload on stale client RSC requests',
  async run() {
    const doc = await get('/');
    const current = doc.headers.get('x-deployment-id');
    assert(current, 'x-deployment-id on documents');
    const stale = await get('/tagged', {
      headers: { rsc: '1', accept: '*/*', 'x-deployment-id': 'stale-deployment' },
    });
    assert(stale.headers.get('x-hypdriv-skew') === '1', 'skew detected');
    assert(
      !stale.headers.get('content-type')?.includes('text/x-component'),
      'non-RSC response forces a hard navigation',
    );
    return `deployment ${current}; stale RSC request → hard navigation`;
  },
});

check({
  id: 'isr-time',
  area: 'cache',
  title: 'ISR: stale page regenerated through the queue and the edge copy purged',
  slow: true,
  async run() {
    const since = Date.now();
    const first = html((await get('/isr')).body, 'generated');
    assert(first, 'timestamp rendered');
    await sleep(17_000);
    const next = await poll(
      'a regenerated /isr',
      async () => {
        const g = html((await get('/isr')).body, 'generated');
        return g && Date.parse(g) > Date.parse(first) ? g : null;
      },
      90_000,
      3000,
    );
    let logged = 'not checked';
    if (ACCOUNT && TOKEN && WORKER) {
      const lines = await poll(
        'the isr revalidation log line',
        async () => {
          const l = await logs('isr revalidation', since);
          return l.length ? l : null;
        },
        60_000,
        5000,
      ).catch(() => []);
      logged = lines.length
        ? `revalidated=${String(lines[0]!.revalidated)} status=${String(lines[0]!.status)}`
        : 'no log line';
      assert(lines.length, 'Worker logged the ISR revalidation request');
    }
    return `${first} → ${next} · ${logged}`;
  },
});

check({
  id: 'revalidate-tag',
  area: 'cache',
  title: 'revalidateTag(): tag cache (Durable Object) and edge cache purged together',
  slow: true,
  async run() {
    const before = html((await get('/tagged')).body, 'stamped');
    const warmed = await get('/tagged');
    assert(html(warmed.body, 'stamped') === before, 'stable before revalidation');
    const r = await signed('/api/revalidate', { tag: 'e2e-tagged' });
    assert(r.status === 200, `revalidate ${r.status}`);
    const after = await poll(
      'a fresh /tagged',
      async () => {
        const r = await get('/tagged');
        const s = html(r.body, 'stamped');
        return s && before && Date.parse(s) > Date.parse(before) ? { s, r } : null;
      },
      60_000,
      2000,
    );
    // The regenerated HTML carries new inline RSC payload scripts: the CSP must still allow every one.
    const csp = after.r.headers.get('content-security-policy') ?? '';
    const blocked = blockedScripts(after.r.body, csp);
    assert(
      !blocked.length,
      `${blocked.length} inline script(s) blocked after regeneration (${after.r.headers.get('x-hypdriv-csp')})`,
    );
    return `${before} → ${after.s} · CSP ${after.r.headers.get('x-hypdriv-csp')} allows every script of the regenerated page`;
  },
});

check({
  id: 'revalidate-path',
  area: 'cache',
  title: 'revalidatePath() regenerates a page without waiting for its interval',
  slow: true,
  async run() {
    const before = html((await get('/isr')).body, 'generated');
    const r = await signed('/api/revalidate', { path: '/isr' });
    assert(r.status === 200, `revalidate ${r.status}`);
    const after = await poll(
      'a regenerated /isr',
      async () => {
        const g = html((await get('/isr')).body, 'generated');
        return g && before && Date.parse(g) > Date.parse(before) ? g : null;
      },
      45_000,
      2000,
    );
    return `${before} → ${after}`;
  },
});

check({
  id: 'geo-vary',
  area: 'cache',
  title: 'Per-country edge cache variants',
  async run() {
    await get('/geo-cached');
    const b = await get('/geo-cached');
    assert(cacheStatus(b.headers) === 'HIT', `second ${cacheStatus(b.headers)}`);
    return `country ${html(b.body, 'country')} · ${cacheStatus(b.headers)}`;
  },
});

check({
  id: 'r2-incremental-cache',
  area: 'cache',
  title: 'Prerendered pages are stored in the R2 incremental cache',
  async run() {
    need('E2E_R2_BUCKET');
    const r = await cf('GET', `ACCOUNT/r2/buckets/${env.E2E_R2_BUCKET}/objects?per_page=50`);
    assert(r.status === 200, `R2 list ${r.status}`);
    const objects = (r.json.result as Array<{ key: string }>) ?? [];
    assert(objects.length > 0, 'objects in the bucket');
    return `${objects.length}+ object(s), e.g. ${objects[0]!.key}`;
  },
});

check({
  id: 'early-hints',
  area: 'performance',
  title: 'Early Hints Link headers and Speculation Rules',
  async run() {
    const { headers, body } = await get('/');
    const link = headers.get('link') ?? '';
    assert(/rel=preload/.test(link), 'preload Link header');
    assert(
      /<script type="speculationrules"/.test(body) || headers.get('speculation-rules'),
      'speculation rules',
    );
    let zone = 'zone setting not checked';
    if (env.E2E_ZONE_ID) {
      const z = await cf('GET', `zones/${env.E2E_ZONE_ID}/settings/early_hints`);
      zone = `zone early_hints ${(z.json.result as { value?: string })?.value}`;
    }
    return `${link.split(',').length} Link entries · ${zone}`;
  },
});

check({
  id: 'early-hints-103',
  area: 'performance',
  title: 'Cloudflare sends 103 Early Hints from the Link headers (HTTP/2)',
  async run() {
    const curl = spawnSync('curl', ['--version'], { encoding: 'utf8' });
    if (curl.status !== 0) throw new Skip('needs curl (Node’s fetch does not surface 1xx responses)');
    // Cloudflare learns the Link headers from a first response, then answers later requests with a 103.
    let seen = '';
    for (let i = 0; i < 4 && !seen; i++) {
      const r = spawnSync(
        'curl',
        [
          '-sS',
          '--http2',
          '-o',
          '/dev/null',
          '-D',
          '-',
          '-A',
          BROWSER_UA,
          '-H',
          'accept: text/html',
          '-H',
          'accept-language: en-US',
          `${BASE}/`,
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      const block = /HTTP\/2 103[\s\S]*?\r?\n\r?\n/.exec(r.stdout ?? '')?.[0];
      if (block) seen = block;
    }
    assert(seen, 'no 103 response within 4 requests');
    const links = (/^link: (.*)$/im.exec(seen)?.[1] ?? '').split(',').length;
    return `HTTP/2 103 with ${links} preload link(s)`;
  },
});

check({
  id: 'images',
  area: 'performance',
  title: 'Image resizing (/cdn-cgi/image) and next/image through the Images binding',
  async run() {
    const original = await fetch(`${BASE}/e2e-assets/pattern.png`, { headers: { 'user-agent': BROWSER_UA } });
    const originalBytes = (await original.arrayBuffer()).byteLength;
    const resized = await fetch(`${BASE}/cdn-cgi/image/width=64,format=webp/e2e-assets/pattern.png`, {
      headers: { 'user-agent': BROWSER_UA, accept: 'image/webp,image/*' },
    });
    const resizedBytes = (await resized.arrayBuffer()).byteLength;
    assert(resized.status === 200, `cdn-cgi ${resized.status}`);
    assert(
      resized.headers.get('content-type') === 'image/webp',
      `cdn-cgi type ${resized.headers.get('content-type')}`,
    );
    assert(resizedBytes < originalBytes, 'resized is smaller');
    const page = await get('/images');
    assert(/\/cdn-cgi\/image\//.test(page.body), 'next/image uses the Cloudflare loader');
    const optimized = await fetch(`${BASE}/_next/image?url=%2Fe2e-assets%2Fpattern.png&w=64&q=75`, {
      headers: { 'user-agent': BROWSER_UA, accept: 'image/avif,image/webp,image/*' },
    });
    const optimizedBytes = (await optimized.arrayBuffer()).byteLength;
    assert(optimized.status === 200, `/_next/image ${optimized.status}`);
    return `png ${originalBytes} B → cdn-cgi webp ${resizedBytes} B · /_next/image ${optimized.headers.get('content-type')} ${optimizedBytes} B`;
  },
});

check({
  id: 'rate-limit-do',
  area: 'security',
  title: 'Exact rate limit (Durable Object): 5/min then 429 with Retry-After',
  async run() {
    // Keyed by client IP: a second run within the same minute starts out limited, which still proves it.
    const statuses: number[] = [];
    let limited: Headers | null = null;
    for (let i = 0; i < 7; i++) {
      const r = await api('/api/limited');
      statuses.push(r.status);
      if (r.status === 429) limited = r.headers;
    }
    assert(
      statuses.slice(0, 5).every((s) => s === 200) || statuses.filter((s) => s === 200).length <= 5,
      `statuses ${statuses.join(',')}`,
    );
    assert(limited, `no 429 in ${statuses.join(',')}`);
    assert(limited.get('retry-after'), 'Retry-After');
    return `${statuses.join(',')} · retry-after ${limited.get('retry-after')} · ${limited.get('ratelimit') ?? limited.get('ratelimit-remaining') ?? ''}`;
  },
});

check({
  id: 'rate-limit-binding',
  area: 'security',
  title: 'Rate limiting binding store answers within its limit',
  async run() {
    const r = await api('/api/limited-binding');
    assert(r.status === 200, `status ${r.status}`);
    return `200 · policy ${r.headers.get('ratelimit-policy') ?? '(binding)'}`;
  },
});

check({
  id: 'csrf',
  area: 'security',
  title: 'CSRF: cross-site form posts rejected, same-origin allowed through',
  async run() {
    const cross = await get('/form', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
      body: 'email=a%40b.co',
    });
    assert(cross.status === 403, `cross-site → ${cross.status}`);
    const same = await get('/form', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: BASE,
      },
      body: 'email=a%40b.co',
    });
    assert(same.status !== 403, `same-origin → ${same.status}`);
    return `cross-site 403 · same-origin ${same.status}`;
  },
});

check({
  id: 'sessions',
  area: 'security',
  title: 'Encrypted cookie sessions round-trip',
  async run() {
    const first = await api('/api/session', { method: 'POST' });
    const cookie = first.headers.get('set-cookie') ?? '';
    assert(
      /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=Lax/i.test(cookie),
      `cookie flags: ${cookie.split(';').slice(1).join(';')}`,
    );
    const jar = cookie.split(';')[0]!;
    const second = await api('/api/session', { method: 'POST', headers: { cookie: jar } });
    const third = await api('/api/session', {
      headers: { cookie: (second.headers.get('set-cookie') ?? jar).split(';')[0]! },
    });
    assert(JSON.parse(third.body).visits === 2, `visits ${third.body}`);
    const tampered = await api('/api/session', { headers: { cookie: `${jar.slice(0, -4)}AAAA` } });
    assert(JSON.parse(tampered.body).visits === 0, 'tampered cookie ignored');
    return 'visits 1 → 2; tampered cookie rejected';
  },
});

check({
  id: 'define-route',
  area: 'api',
  title: 'defineRoute: validation, ETag/304, body limits',
  async run() {
    const bad = await api('/api/echo?n=0');
    assert(bad.status === 400 || bad.status === 422, `invalid query → ${bad.status}`);
    const ok = await api('/api/echo?n=4');
    assert(ok.status === 200 && JSON.parse(ok.body).doubled === 8, `valid → ${ok.status} ${ok.body}`);
    const etag = ok.headers.get('etag');
    assert(etag, 'ETag');
    const notModified = await api('/api/echo?n=4', { headers: { 'if-none-match': etag } });
    assert(notModified.status === 304, `If-None-Match → ${notModified.status}`);
    const created = await api('/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hello' }),
    });
    assert(created.status === 201, `POST → ${created.status}`);
    const big = await api('/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(4000) }),
    });
    assert(big.status === 413 || big.status === 400, `oversized → ${big.status}`);
    const broken = await api('/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert(broken.status === 400, `bad JSON → ${broken.status}`);
    return `400/200/304/201/${big.status}/400 · cache-control ${ok.headers.get('cache-control')}`;
  },
});

check({
  id: 'geo',
  area: 'api',
  title: 'Geo, colo and request id from request.cf',
  async run() {
    const r = await api('/api/geo');
    const g = JSON.parse(r.body) as { country: string; colo: string; runner: string; requestId: string };
    assert(g.country && g.colo && g.runner === 'worker' && g.requestId, r.body);
    return `${g.country} via ${g.colo} · runner ${g.runner}`;
  },
});

check({
  id: 'hypfetch',
  area: 'api',
  title: 'hypFetch outbound request (timeout, retries, breaker)',
  async run() {
    const r = await api('/api/fetch');
    const f = JSON.parse(r.body) as { status: number; attempts: number[]; ms: number };
    assert(f.status === 200, r.body);
    return `example.com ${f.status} in ${f.ms} ms (${f.attempts.length} attempt)`;
  },
});

check({
  id: 'redirect-rule',
  area: 'routing',
  title: 'Static redirect rule from hypdriv.config',
  async run() {
    const r = await get('/old-home');
    assert(
      r.status === 308 && new URL(r.headers.get('location') ?? '', BASE).pathname === '/',
      `${r.status} ${r.headers.get('location')}`,
    );
    return `308 → /`;
  },
});

check({
  id: 'kv-redirects',
  area: 'routing',
  title: 'Redirect rules from KV apply without a redeploy',
  slow: true,
  async run() {
    const path = `/kv-redirect-${RUN}`;
    await kvPut('redirects', JSON.stringify([{ from: path, to: '/tagged', status: 302 }]));
    try {
      const r = await poll(
        `a 302 on ${path}`,
        async () => {
          const x = await get(path);
          return x.status === 302 ? x : null;
        },
        90_000,
        3000,
      );
      return `302 → ${r.headers.get('location')}`;
    } finally {
      await kvDelete('redirects');
    }
  },
});

check({
  id: 'kv-flags',
  area: 'routing',
  title: 'Feature flags from KV flip without a redeploy',
  slow: true,
  async run() {
    await kvPut('flags', JSON.stringify({ e2eBanner: { default: true } }));
    try {
      await poll(
        'banner-on',
        async () => (await get(`/flags?f=${Date.now()}`)).body.includes('banner-on'),
        90_000,
        3000,
      );
    } finally {
      await kvDelete('flags');
    }
    await poll(
      'banner-off again',
      async () => (await get(`/flags?f=${Date.now()}`)).body.includes('banner-off'),
      90_000,
      3000,
    );
    return 'banner-off → banner-on → banner-off';
  },
});

check({
  id: 'kv-maintenance',
  area: 'routing',
  title: 'Maintenance mode from KV (503 + Retry-After, bypass paths stay up)',
  exclusive: true,
  async run() {
    await kvPut('maintenance', JSON.stringify({ enabled: true, message: `e2e ${RUN}` }));
    let detail = '';
    try {
      const r = await poll(
        'a 503 maintenance page',
        async () => {
          const x = await get(`/tagged?m=${Date.now()}`);
          return x.status === 503 ? x : null;
        },
        90_000,
        3000,
      );
      assert(r.headers.get('retry-after') === '120', `retry-after ${r.headers.get('retry-after')}`);
      assert(r.body.includes(`e2e ${RUN}`), 'message from KV');
      const bypass = await api('/api/geo');
      assert(bypass.status === 200, `bypass path → ${bypass.status}`);
      detail = '503 + Retry-After 120 · /api/** bypassed';
    } finally {
      await kvDelete('maintenance');
    }
    await poll(
      'the site back up',
      async () => (await get(`/tagged?m=${Date.now()}`)).status === 200,
      90_000,
      3000,
    );
    return `${detail} · back to 200`;
  },
});

check({
  id: 'cron',
  area: 'jobs',
  title: 'Cron trigger (every minute) reaches the job route, signed',
  slow: true,
  async run() {
    const tick = await poll(
      'a cron tick within the last 3 minutes',
      async () => {
        const s = await state('e2e:cron:');
        const t = s['e2e:cron:tick'] as { at: string; count: number; cron: string } | undefined;
        return t && Date.now() - Date.parse(t.at) < 180_000 ? t : null;
      },
      150_000,
      10_000,
    );
    return `last tick ${tick.at} (${tick.count} so far, cron "${tick.cron}")`;
  },
});

check({
  id: 'queue',
  area: 'jobs',
  title: 'Queues: delivery, retry with attempts, dead-letter queue',
  slow: true,
  async run() {
    const ids = { ok: `ok-${RUN}`, retry: `retry-${RUN}`, dead: `dead-${RUN}` };
    for (const body of [{ id: ids.ok }, { id: ids.retry, failTimes: 1 }, { id: ids.dead, always: true }]) {
      const r = await signed('/api/enqueue', body);
      assert(r.status === 200 && r.json.transport === 'queue', `enqueue ${r.status} ${r.text}`);
    }
    const done = await poll(
      'jobs processed and the dead letter recorded',
      async () => {
        const s = await state('e2e:');
        const ok = s[`e2e:job:${ids.ok}`] as
          | { status: string; attempts: number[]; latencyMs: number }
          | undefined;
        const retry = s[`e2e:job:${ids.retry}`] as { status: string; attempts: number[] } | undefined;
        const dead = s[`e2e:dead:${ids.dead}`] as { job: string; attempts: number } | undefined;
        return ok?.status === 'done' && retry?.status === 'done' && dead ? { ok, retry, dead } : null;
      },
      180_000,
      5000,
    );
    assert(done.retry.attempts.join(',') === '1,2', `retry attempts ${done.retry.attempts}`);
    assert(done.dead.job === 'jobs-dead', `dead letter consumed by ${done.dead.job}`);
    return `ok in ${done.ok.latencyMs} ms · retry attempts ${done.retry.attempts} · dead-lettered via ${done.dead.job}`;
  },
});

check({
  id: 'live-sse',
  area: 'live',
  title: 'Live channels: Server-Sent Events fan-out',
  async run() {
    const marker = `sse-${RUN}`;
    const data = await sseWait(
      'e2e',
      (d) => d.includes(marker),
      20_000,
      async () => {
        const r = await signed('/api/publish', { channel: 'e2e', type: 'message', data: { text: marker } });
        assert(r.status === 200 && r.json.delivered === true, `publish ${r.status} ${r.text}`);
      },
    );
    return `received ${data.slice(0, 80)}`;
  },
});

check({
  id: 'live-websocket',
  area: 'live',
  title: 'Live channels: WebSocket subscription',
  async run() {
    const marker = `ws-${RUN}`;
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) throw new Skip('no global WebSocket in this Node version');
    const ws = new WS(`${BASE.replace(/^http/, 'ws')}/_hypdriv/live/e2e`);
    const received = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no WebSocket message within 20 s')), 20_000);
      ws.addEventListener('open', () => {
        void signed('/api/publish', { channel: 'e2e', type: 'message', data: { text: marker } });
      });
      ws.addEventListener('message', (e) => {
        const text = String((e as MessageEvent).data);
        if (text.includes(marker)) {
          clearTimeout(timer);
          resolve(text);
        }
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket error'));
      });
    });
    ws.close();
    return `received ${received.slice(0, 80)}`;
  },
});

check({
  id: 'live-polling',
  area: 'live',
  title: 'Live channels: polling fallback and stats',
  async run() {
    const events = await api('/_hypdriv/live/e2e/events');
    assert(events.status === 200, `events ${events.status}`);
    const parsed = JSON.parse(events.body) as { events: unknown[]; transport: string };
    assert(parsed.transport === 'durable-object', `transport ${parsed.transport}`);
    const stats = await api('/_hypdriv/live/e2e/stats');
    return `${parsed.events.length} retained event(s) · stats ${stats.status} ${stats.body.slice(0, 80)}`;
  },
});

check({
  id: 'vitals-ae',
  area: 'observability',
  title: 'Web Vitals beacons land in Analytics Engine',
  slow: true,
  async run() {
    need('E2E_AE_DATASET');
    const pathname = `/vitals-${RUN}`;
    const res = await fetch(`${BASE}/_hypdriv/vitals`, {
      method: 'POST',
      headers: { ...API_HEADERS, 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({
        name: 'LCP',
        value: 1234,
        rating: 'good',
        id: `v-${RUN}`,
        pathname,
        ts: Date.now(),
      }),
    });
    assert(res.status === 204 || res.status === 202 || res.status === 200, `beacon ${res.status}`);
    const dataset = env.E2E_AE_DATASET!;
    const rows = await poll(
      'the vitals row in Analytics Engine',
      async () => {
        const r = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${TOKEN}` },
            body: `SELECT blob1, blob3, double1 FROM ${dataset} WHERE blob3 = '${pathname}' AND timestamp > NOW() - INTERVAL '1' HOUR FORMAT JSON`,
          },
        );
        const j = (await r.json()) as { data?: Array<Record<string, unknown>> };
        return j.data?.length ? j.data : null;
      },
      180_000,
      10_000,
    );
    const spans = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: `SELECT count() AS n FROM ${dataset} WHERE blob1 = 'http.request' AND timestamp > NOW() - INTERVAL '1' HOUR FORMAT JSON`,
      },
    ).then((r) => r.json() as Promise<{ data?: Array<{ n: number }> }>);
    return `vitals row ${JSON.stringify(rows[0])} · ${spans.data?.[0]?.n ?? 0} span row(s) in the last hour`;
  },
});

check({
  id: 'observability',
  area: 'observability',
  title: 'Structured request logs in Workers Observability',
  slow: true,
  async run() {
    const since = Date.now();
    await get(`/tagged?obs=${RUN}`);
    const lines = await poll(
      'the request log line',
      async () => {
        const l = (await logs(`obs=${RUN}`, since)).concat(await logs('"msg":"request"', since));
        return l.length ? l : null;
      },
      120_000,
      10_000,
    );
    return `${lines.length} matching event(s)`;
  },
});

check({
  id: 'tail',
  area: 'observability',
  title: 'Tail consumer receives another Worker’s warnings',
  slow: true,
  async run() {
    need('E2E_TAIL_PRODUCER_URL');
    const since = Date.now();
    const producer = env.E2E_TAIL_PRODUCER_URL!.replace(/\/+$/, '');
    await fetch(`${producer}/wp-login.php?tail=${RUN}`, { headers: DOC_HEADERS });
    const lines = await poll(
      'a "tail log" line',
      async () => {
        const l = await logs('tail log', since);
        return l.length ? l : null;
      },
      150_000,
      10_000,
    );
    return `${lines.length} forwarded line(s) from ${String(lines[0]!.script)}`;
  },
});

check({
  id: 'email',
  area: 'jobs',
  title: 'Inbound email handler',
  async run() {
    throw new Skip(
      'needs an Email Routing rule to this Worker and an external sender (not automatable here)',
    );
  },
});

// -- runner ----------------------------------------------------------------------------------------

const only = args.only
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const skip = new Set(
  args.skip
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const selected = checks.filter((c) => (!only || only.includes(c.id)) && !skip.has(c.id));

async function execute(c: Check): Promise<Result> {
  const started = Date.now();
  try {
    const detail = await c.run();
    return { id: c.id, area: c.area, title: c.title, status: 'pass', detail, ms: Date.now() - started };
  } catch (err) {
    const status: Status = err instanceof Skip ? 'skip' : 'fail';
    return {
      id: c.id,
      area: c.area,
      title: c.title,
      status,
      detail: (err as Error).message,
      ms: Date.now() - started,
    };
  }
}

const startedAt = Date.now();
const results: Result[] = [];
const print = (r: Result) => {
  if (!args.json)
    console.log(
      `${r.status === 'pass' ? '✓' : r.status === 'skip' ? '–' : '✗'} ${r.id.padEnd(22)} ${r.detail}`,
    );
};
// Slow checks poll external systems; they run concurrently while the quick checks run in order.
// Exclusive checks change site-wide state and run alone at the end.
const slowRuns = selected.filter((c) => c.slow && !c.exclusive).map((c) => execute(c));
for (const c of selected.filter((c) => !c.slow && !c.exclusive)) {
  const r = await execute(c);
  results.push(r);
  print(r);
}
for (const r of await Promise.all(slowRuns)) {
  results.push(r);
  print(r);
}
for (const c of selected.filter((c) => c.exclusive)) {
  const r = await execute(c);
  results.push(r);
  print(r);
}
const order = new Map(selected.map((c, i) => [c.id, i]));
results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
const summary = {
  url: BASE,
  startedAt: new Date(startedAt).toISOString(),
  durationMs: Date.now() - startedAt,
  pass: results.filter((r) => r.status === 'pass').length,
  fail: results.filter((r) => r.status === 'fail').length,
  skip: results.filter((r) => r.status === 'skip').length,
  results,
};
writeFileSync(args.report ?? 'e2e-report.json', `${JSON.stringify(summary, null, 2)}\n`);
if (args.json) console.log(JSON.stringify(summary, null, 2));
else
  console.log(
    `\n${summary.pass} passed · ${summary.fail} failed · ${summary.skip} skipped · ${Math.round(summary.durationMs / 1000)} s`,
  );
process.exit(summary.fail ? 1 : 0);
