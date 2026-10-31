/**
 * Live end-to-end suite for HypDriv on Vercel. Runs against a production deployment of this app (see
 * README.md) and verifies every capability through its public behaviour and the Vercel REST API.
 *
 *   E2E_URL=https://hypdriv-e2e-vercel.example.com \
 *   HYPDRIV_INTERNAL_SECRET=… CRON_SECRET=… VERCEL_TOKEN=… VERCEL_TEAM_ID=team_… \
 *   E2E_VERCEL_PROJECT=prj_… E2E_GLOBAL_CONFIG_ID=ecfg_… \
 *   pnpm -F @hypdriv/e2e-vercel e2e [--only <id,…>] [--skip <id,…>] [--json]
 *
 * Optional: E2E_TURNSTILE=test (the deployment currently uses Cloudflare's always-pass Turnstile test keys:
 * solve the challenge in Chromium), E2E_TURNSTILE_SITE_KEY (the site key the challenge page must carry).
 *
 * Function output (queue deliveries, cron runs, vitals, spans, request logs) is read from the deployment's
 * runtime-logs stream, which the runner opens before the first check. Exit code 1 when a check fails.
 * Writes `e2e-report.json`.
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
  /** Runs alone, after every other check (site-wide state such as maintenance, or timing-sensitive pages). */
  exclusive?: boolean;
  run: () => Promise<string>;
}

class Skip extends Error {}

/** The slice of Playwright the browser checks use (resolved at run time, not a dependency). */
interface PlaywrightPage {
  goto(
    url: string,
    o: { waitUntil: 'domcontentloaded' | 'networkidle' },
  ): Promise<{ status(): number } | null>;
  waitForSelector(selector: string, o: { timeout: number }): Promise<unknown>;
  textContent(selector: string): Promise<string | null>;
  on(event: 'console', fn: (m: { type(): string; text(): string }) => void): void;
}
interface PlaywrightRoute {
  request(): { url(): string; headers(): Record<string, string> };
  continue(o?: { headers?: Record<string, string> }): Promise<void>;
}
interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  cookies(
    url: string,
  ): Promise<Array<{ name: string; httpOnly: boolean; secure: boolean; sameSite: string }>>;
  route(url: string, handler: (route: PlaywrightRoute) => Promise<void> | void): Promise<void>;
}
interface PlaywrightLike {
  chromium: {
    launch(): Promise<{
      newContext(o: { userAgent?: string }): Promise<PlaywrightContext>;
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
    /** Writes every runtime-log line the run read (NDJSON) for debugging. */
    logs: { type: 'string' },
  },
});

const env = process.env;
const BASE = (env.E2E_URL ?? '').replace(/\/+$/, '');
if (!BASE) {
  console.error(
    'E2E_URL is required (the production deployment, e.g. https://hypdriv-e2e-vercel.example.com)',
  );
  process.exit(2);
}
const HOST = new URL(BASE).host;
const SECRET = env.HYPDRIV_INTERNAL_SECRET ?? '';
const CRON_SECRET = env.CRON_SECRET ?? '';
const TOKEN = env.VERCEL_TOKEN ?? '';
const TEAM = env.VERCEL_TEAM_ID ?? '';
const PROJECT = env.E2E_VERCEL_PROJECT ?? '';
const GLOBAL_CONFIG_ID = env.E2E_GLOBAL_CONFIG_ID ?? '';
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

const GATE_HOSTS = new Set([HOST]);

// -- gateways --------------------------------------------------------------------------------------

/**
 * Headers that get the runner through a gateway in front of a private test deployment: Vercel Deployment
 * Protection (`VERCEL_AUTOMATION_BYPASS_SECRET`), Cloudflare Access service tokens (`CF_ACCESS_CLIENT_ID` +
 * `CF_ACCESS_CLIENT_SECRET`) or any other gate (`HYPDRIV_ACCESS_HEADERS`: `name: value` lines, `\\n`-separated
 * on one line, or a JSON object) — the same variables `hypdriv audit` reads. They are added to HTTPS requests
 * to the suite's own hosts only (never over plain HTTP, never to third parties).
 */
function gateHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET)
    out['x-vercel-protection-bypass'] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    out['cf-access-client-id'] = env.CF_ACCESS_CLIENT_ID;
    out['cf-access-client-secret'] = env.CF_ACCESS_CLIENT_SECRET;
  }
  const raw = (env.HYPDRIV_ACCESS_HEADERS ?? '').trim();
  if (raw.startsWith('{')) Object.assign(out, JSON.parse(raw) as Record<string, string>);
  else
    for (const line of raw.replace(/\\n/g, '\n').split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  return out;
}

const GATE = gateHeaders();
const GATED = Object.keys(GATE).length > 0;
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!GATED || url.protocol !== 'https:' || !GATE_HOSTS.has(url.host)) return nativeFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const [name, value] of Object.entries(GATE)) if (!headers.has(name)) headers.set(name, value);
  return input instanceof Request
    ? nativeFetch(new Request(input, { ...init, headers }))
    : nativeFetch(input, { ...init, headers });
}) as typeof fetch;

/** curl arguments carrying the gate headers (HTTPS only). */
const curlGate = (url: string): string[] =>
  url.startsWith('https://') ? Object.entries(GATE).flatMap(([n, v]) => ['-H', `${n}: ${v}`]) : [];

/** Lets a Playwright context through the gate for the suite's hosts only. */
async function gateBrowser(context: PlaywrightContext): Promise<void> {
  if (!GATED) return;
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol !== 'https:' || !GATE_HOSTS.has(url.host)) return route.continue();
    return route.continue({ headers: { ...request.headers(), ...GATE } });
  });
}

// -- helpers ---------------------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

function needVercel(): void {
  const missing = [
    ['VERCEL_TOKEN', TOKEN],
    ['VERCEL_TEAM_ID', TEAM],
    ['E2E_VERCEL_PROJECT', PROJECT],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Skip(`needs ${missing.join(', ')}`);
}

async function vercel<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
  needVercel();
  const url = new URL(`https://api.vercel.com${path}`);
  url.searchParams.set('teamId', TEAM);
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json: json as T };
}

/** Upserts (or, with `null`, deletes) one Global Config item through the REST API. */
async function globalConfigSet(key: string, value: unknown | null): Promise<void> {
  if (!GLOBAL_CONFIG_ID) throw new Skip('needs E2E_GLOBAL_CONFIG_ID');
  const item = value === null ? { operation: 'delete', key } : { operation: 'upsert', key, value };
  const r = await vercel('PATCH', `/v1/global-config/${GLOBAL_CONFIG_ID}/items`, { items: [item] });
  // Deleting a key that does not exist is fine.
  assert(r.status === 200 || (value === null && r.status < 500), `Global Config ${key}: HTTP ${r.status}`);
}

function html(body: string, id: string): string | null {
  const m = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(body);
  return m ? m[1]! : null;
}

function vercelCache(h: Headers): string {
  return h.get('x-vercel-cache') ?? '—';
}

const CDN_HITS = new Set(['HIT', 'STALE', 'PRERENDER']);

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

// -- runtime logs ----------------------------------------------------------------------------------

interface LogLine {
  message: string;
  level: string;
  source: string;
  requestPath: string;
  responseStatusCode: number;
  timestampInMs: number;
  /** The message parsed as JSON when it is a structured line. */
  data: Record<string, unknown> | null;
}

const logLines: LogLine[] = [];
let deploymentId: string | null = null;
let logStream: {
  stop(): void;
  ready: Promise<void>;
  error: string | null;
  connects: number;
  connected: boolean;
} | null = null;

function parseLine(text: string): LogLine | null {
  try {
    const row = JSON.parse(text) as Omit<LogLine, 'data'>;
    let data: Record<string, unknown> | null = null;
    const message = typeof row.message === 'string' ? row.message.trim() : '';
    if (message.startsWith('{')) {
      try {
        data = JSON.parse(message) as Record<string, unknown>;
      } catch {
        data = null;
      }
    }
    return { ...row, message, data };
  } catch {
    return null;
  }
}

/** Keeps the deployment's runtime-logs stream open (reconnecting when Vercel closes it) and buffers lines. */
function openLogStream(): NonNullable<typeof logStream> {
  const controller = new AbortController();
  const state = {
    stop: () => controller.abort(),
    ready: Promise.resolve(),
    error: null as string | null,
    connects: 0,
    connected: false,
  };
  let markReady: () => void = () => undefined;
  state.ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const loop = async () => {
    while (!controller.signal.aborted) {
      try {
        const url = new URL(
          `https://api.vercel.com/v1/projects/${PROJECT}/deployments/${deploymentId}/runtime-logs`,
        );
        url.searchParams.set('teamId', TEAM);
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${TOKEN}` },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          state.error = `runtime logs answered ${res.status}`;
          await sleep(3000);
          continue;
        }
        state.error = null;
        state.connects++;
        state.connected = true;
        markReady();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            state.connected = false;
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf('\n');
          while (nl >= 0) {
            const line = parseLine(buffer.slice(0, nl));
            if (line) logLines.push(line);
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf('\n');
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        state.connected = false;
        state.error = (err as Error).message;
        await sleep(1000);
      }
    }
  };
  void loop();
  return state;
}

/**
 * Resolves the deployment behind E2E_URL, opens its runtime-logs stream and sends probe requests until one
 * shows up in it, so checks start with a live stream. Vercel answers the stream request only once there is
 * a line to send, so the probes are what makes it connect. Returns a status line.
 */
async function startLogs(): Promise<string> {
  if (!TOKEN || !TEAM || !PROJECT) return 'not used (needs VERCEL_TOKEN, VERCEL_TEAM_ID, E2E_VERCEL_PROJECT)';
  const r = await vercel<{ id?: string; readyState?: string }>('GET', `/v13/deployments/${HOST}`);
  if (r.status !== 200 || !r.json.id) return `deployment for ${HOST} not found (${r.status})`;
  deploymentId = r.json.id;
  logStream = openLogStream();
  const probe = `logprobe-${RUN}`;
  const started = Date.now();
  for (let i = 0; Date.now() - started < 90_000; i++) {
    // A CSP report is logged with its blocked URI by the proxy: a cheap, unique marker.
    await fetch(`${BASE}/_hypdriv/csp-report`, {
      method: 'POST',
      headers: { ...API_HEADERS, 'content-type': 'application/csp-report' },
      body: JSON.stringify({
        'csp-report': {
          'document-uri': `${BASE}/`,
          'effective-directive': 'script-src-elem',
          'blocked-uri': `https://probe.invalid/${probe}-${i}.js`,
          disposition: 'report',
        },
      }),
    }).catch(() => undefined);
    for (let w = 0; w < 6; w++) {
      if (logLines.some((l) => l.message.includes(probe)))
        return `live after ${Math.round((Date.now() - started) / 1000)} s (deployment ${deploymentId})`;
      await sleep(500);
    }
  }
  return logStream.connected
    ? 'connected, but no probe line within 90 s (log-based checks may retry)'
    : `did not connect within 90 s${logStream.error ? `: ${logStream.error}` : ''}`;
}

/**
 * Vercel's runtime-logs stream is best-effort: lines can arrive late or not at all (bursts, reconnects).
 * Triggers an action and waits for its log line, re-triggering with a fresh marker up to `attempts` times.
 */
async function confirmLogged<T>(
  what: string,
  trigger: (attempt: number) => Promise<T>,
  match: (line: LogLine, value: T) => boolean,
  options: { attempts?: number; waitMs?: number } = {},
): Promise<{ lines: LogLine[]; value: T; attempt: number }> {
  needLogs();
  const attempts = options.attempts ?? 3;
  let last: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const value = await trigger(attempt);
    try {
      const lines = await waitLogs(what, (l) => match(l, value), options.waitMs ?? 25_000);
      return { lines, value, attempt };
    } catch (err) {
      last = err as Error;
    }
  }
  throw new Error(`${last?.message ?? what} (${attempts} attempts)`);
}

function stopLogs(): void {
  logStream?.stop();
}

function needLogs(): void {
  needVercel();
  if (!logStream || !deploymentId) throw new Skip('runtime-logs stream unavailable (deployment not found)');
  if (logStream.error && !logLines.length) throw new Error(`runtime-logs stream: ${logStream.error}`);
}

async function waitLogs(
  what: string,
  match: (line: LogLine) => boolean,
  timeoutMs: number,
  count = 1,
): Promise<LogLine[]> {
  needLogs();
  return poll(
    what,
    async () => {
      const found = logLines.filter(match);
      return found.length >= count ? found : null;
    },
    timeoutMs,
    1000,
  );
}

const markers = (kind: string, pred: (d: Record<string, unknown>) => boolean) => (l: LogLine) =>
  l.data?.e2e === kind && pred(l.data);

// -- checks ----------------------------------------------------------------------------------------

const checks: Check[] = [];
const check = (c: Check) => checks.push(c);

check({
  id: 'health',
  area: 'platform',
  title: 'Health endpoint lists the Vercel services HypDriv detected',
  async run() {
    const { status, body } = await api('/_hypdriv/health');
    assert(status === 200, `status ${status}`);
    const h = JSON.parse(body) as { capabilities: string[]; build: string; deployment: string | null };
    const caps = h.capabilities.join(' | ');
    for (const expected of [
      'cache: Vercel CDN',
      'tag purge: Vercel CDN tag purge',
      'Vercel WAF',
      'config store: Global Config',
      'images: Vercel Image Optimization',
      'queues: Vercel Queues',
    ])
      assert(caps.includes(expected), `capability missing: ${expected} (${caps})`);
    assert(h.build, 'build fingerprint reported');
    if (deploymentId) assert(h.deployment === deploymentId, `deployment ${h.deployment} ≠ ${deploymentId}`);
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
  id: 'region',
  area: 'platform',
  title: 'Functions and Routing Middleware run in iad1 (US-first)',
  async run() {
    const r = await api('/api/geo');
    const id = r.headers.get('x-vercel-id') ?? '';
    // `<edge pop>::<function region>::<request id>`
    const parts = id.split('::');
    assert(parts.length >= 3, `x-vercel-id ${id}`);
    assert(parts.at(-2) === 'iad1', `function region ${parts.at(-2)} (x-vercel-id ${id})`);
    return `x-vercel-id ${id}`;
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
    assert(n1 && n2 && n1 !== n2, `fresh nonce per request (mode ${a.headers.get('x-hypdriv-csp')})`);
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
    const report = (marker: string) =>
      fetch(`${BASE}/_hypdriv/csp-report`, {
        method: 'POST',
        headers: { ...API_HEADERS, 'content-type': 'application/csp-report' },
        body: JSON.stringify({
          'csp-report': {
            'document-uri': `${BASE}/`,
            'violated-directive': 'script-src-elem',
            'effective-directive': 'script-src-elem',
            'blocked-uri': `https://evil.example/${marker}.js`,
            disposition: 'enforce',
          },
        }),
      });
    const res = await report(RUN);
    assert(res.status === 204 || res.status === 202, `status ${res.status}`);
    if (!logStream) return `${res.status} · log not checked`;
    const { lines, attempt } = await confirmLogged(
      'the CSP violation log line',
      async (n) => {
        if (n > 1) await report(`${RUN}-${n}`);
        return n > 1 ? `${RUN}-${n}` : RUN;
      },
      (l, marker) => l.message.includes(`evil.example/${marker}.js`),
    );
    return `${res.status} · logged "${String(lines[0]!.data?.msg)}" at level ${lines[0]!.level} (try ${attempt})`;
  },
});

check({
  id: 'compression',
  area: 'platform',
  title: 'HTML is compressed',
  async run() {
    const res = await fetch(`${BASE}/`, { headers: { ...DOC_HEADERS, 'accept-encoding': 'br, gzip' } });
    await res.arrayBuffer();
    const enc = res.headers.get('content-encoding');
    assert(enc && ['br', 'gzip', 'zstd'].includes(enc), `content-encoding ${enc}`);
    const altSvc = res.headers.get('alt-svc') ?? '';
    return `content-encoding ${enc} · alt-svc ${altSvc.includes('h3') ? 'h3' : 'none'}`;
  },
});

check({
  id: 'static-assets',
  area: 'platform',
  title: 'Static assets: immutable chunks and vercel.json header rules',
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
    assert(asset.headers.get('x-e2e-asset') === '1', 'vercel.json header rule applied');
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
    assert(!vercelCache(r.headers).startsWith('HIT'), 'challenge page not served from the CDN');
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
      await gateBrowser(context);
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
  id: 'cdn-cache',
  area: 'cache',
  title: 'Prerendered pages come from the Vercel CDN; HypDriv reports them as CDN',
  async run() {
    const out: string[] = [];
    for (const path of ['/', '/tagged']) {
      await get(path);
      const second = await get(path);
      const status = vercelCache(second.headers);
      assert(CDN_HITS.has(status), `${path}: second request x-vercel-cache ${status}`);
      assert(
        second.headers.get('x-hypdriv-cache') === 'CDN',
        `${path}: x-hypdriv-cache ${second.headers.get('x-hypdriv-cache')}`,
      );
      assert(
        /cache;desc="CDN"/.test(second.headers.get('server-timing') ?? ''),
        `${path}: Server-Timing cache entry`,
      );
      out.push(`${path} ${status} (age ${second.headers.get('age') ?? 0})`);
    }
    return out.join(' · ');
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
      const next = new URL(rsc.headers.get('location')!, BASE);
      rsc = await get(next.pathname + next.search, { headers: rscHeaders });
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
    return `rsc ${vercelCache(rsc.headers)} · html ${vercelCache(doc.headers)}`;
  },
});

check({
  id: 'geo-vary',
  area: 'cache',
  title: 'Per-country CDN entries for withVercelCdn (Vary: X-Vercel-IP-Country); vary pages stay dynamic',
  async run() {
    const path = `/api/geo-cached?run=${RUN}`;
    const first = await api(path);
    assert(first.status === 200, `status ${first.status}`);
    assert(/x-vercel-ip-country/i.test(first.headers.get('vary') ?? ''), `vary ${first.headers.get('vary')}`);
    const hit = await poll(
      'a CDN HIT on /api/geo-cached',
      async () => {
        const r = await api(path);
        return CDN_HITS.has(vercelCache(r.headers)) ? r : null;
      },
      20_000,
      1000,
    );
    const a = JSON.parse(first.body) as { country: string; renderedAt: string };
    const b = JSON.parse(hit.body) as { country: string; renderedAt: string };
    assert(a.renderedAt === b.renderedAt, 'HIT serves the cached body');
    // A page cannot carry the Vary through route headers on Vercel: it must not be cached for everyone.
    const page = await get(`/geo-cached?run=${RUN}`);
    const again = await get(`/geo-cached?run=${RUN}`);
    assert(
      !CDN_HITS.has(vercelCache(again.headers)),
      `vary page cached for every country (${vercelCache(again.headers)})`,
    );
    assert(
      page.headers.get('x-hypdriv-cache') !== 'CDN',
      `vary page reported as ${page.headers.get('x-hypdriv-cache')}`,
    );
    return `${b.country} · ${vercelCache(hit.headers)} · vary ${hit.headers.get('vary')} · page /geo-cached ${page.headers.get('x-hypdriv-cache')} (${vercelCache(again.headers)})`;
  },
});

check({
  id: 'cdn-api-purge',
  area: 'cache',
  title: 'withVercelCdn caches a Route Handler; revalidateTag() and revalidatePath() purge it',
  slow: true,
  async run() {
    const path = `/api/cdn?run=${RUN}`;
    const read = async () => {
      const r = await api(path);
      return { cache: vercelCache(r.headers), at: (JSON.parse(r.body) as { renderedAt: string }).renderedAt };
    };
    const warm = async (what: string) => {
      const first = await read();
      const hit = await poll(
        `a CDN HIT on /api/cdn (${what})`,
        async () => {
          const r = await read();
          return CDN_HITS.has(r.cache) ? r : null;
        },
        20_000,
        1000,
      );
      assert(hit.at === first.at || Date.parse(hit.at) >= Date.parse(first.at), 'HIT serves the cached body');
      return hit;
    };
    const purgedBy = async (body: Record<string, string>, before: { at: string }) => {
      const r = await signed('/api/revalidate', body);
      assert(r.status === 200, `revalidate ${r.status} ${r.text}`);
      const fresh = await poll(
        `a fresh /api/cdn after ${JSON.stringify(body)}`,
        async () => {
          const x = await read();
          return Date.parse(x.at) > Date.parse(before.at) ? x : null;
        },
        45_000,
        1500,
      );
      return { fresh, purger: r.json.purger };
    };
    const byTagBefore = await warm('tag');
    const byTag = await purgedBy({ tag: 'e2e-cdn' }, byTagBefore);
    const byPathBefore = await warm('path');
    const byPath = await purgedBy({ path: '/api/cdn' }, byPathBefore);
    assert(byPath.purger === true, 'edge purger registered in the Vercel Function');
    return `${byTagBefore.cache} → tag purge → ${byTag.fresh.at} · ${byPathBefore.cache} → path purge → ${byPath.fresh.at} · purger in function: ${String(byPath.purger)}`;
  },
});

check({
  id: 'isr-time',
  area: 'cache',
  title: 'ISR: a stale page is regenerated in the background',
  slow: true,
  async run() {
    const first = html((await get('/isr')).body, 'generated');
    assert(first, 'timestamp rendered');
    await sleep(17_000);
    const next = await poll(
      'a regenerated /isr',
      async () => {
        const g = html((await get('/isr')).body, 'generated');
        return g && Date.parse(g) > Date.parse(first) ? g : null;
      },
      60_000,
      3000,
    );
    return `${first} → ${next}`;
  },
});

check({
  id: 'revalidate-tag',
  area: 'cache',
  title: 'revalidateTag(): Vercel ISR cache and CDN copy refreshed together',
  slow: true,
  async run() {
    // Settled first: a stale copy may still be regenerating in the background from an earlier check.
    const before = await poll(
      'a settled /tagged',
      async () => {
        const a = html((await get('/tagged')).body, 'stamped');
        const b = html((await get('/tagged')).body, 'stamped');
        return a && a === b ? a : null;
      },
      30_000,
      1000,
    );
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
  title: 'revalidatePath() regenerates a page before its interval would',
  // Alone, after isr-time: concurrent reads of /isr would trigger time-based regenerations.
  exclusive: true,
  async run() {
    // Start from a freshly generated /isr (a stale read triggers the regeneration), so a change within its
    // 15 s interval can only come from revalidatePath().
    const fresh = await poll(
      'a freshly generated /isr',
      async () => {
        const g = html((await get('/isr')).body, 'generated');
        return g && Date.now() - Date.parse(g) < 4000 ? g : null;
      },
      90_000,
      1500,
    );
    const r = await signed('/api/revalidate', { path: '/isr' });
    assert(r.status === 200, `revalidate ${r.status}`);
    const after = await poll(
      'a regenerated /isr',
      async () => {
        const g = html((await get('/isr')).body, 'generated');
        return g && Date.parse(g) > Date.parse(fresh) ? g : null;
      },
      Math.max(2000, 15_000 - (Date.now() - Date.parse(fresh)) - 1000),
      1000,
    );
    return `${fresh} → ${after} (${Math.round((Date.parse(after) - Date.parse(fresh)) / 1000)} s, inside the 15 s interval)`;
  },
});

check({
  id: 'early-hints',
  area: 'performance',
  title: 'Link preload headers and Speculation Rules',
  async run() {
    const { headers, body } = await get('/');
    const link = headers.get('link') ?? '';
    assert(/rel=preload/.test(link), 'preload Link header');
    assert(
      /<script type="speculationrules"/.test(body) || headers.get('speculation-rules'),
      'speculation rules',
    );
    return `${link.split(',').length} Link entries`;
  },
});

check({
  id: 'early-hints-103',
  area: 'performance',
  title: 'HTTP/2 103 Early Hints from the Link headers',
  async run() {
    const curl = spawnSync('curl', ['--version'], { encoding: 'utf8' });
    if (curl.status !== 0) throw new Skip('needs curl (Node’s fetch does not surface 1xx responses)');
    for (let i = 0; i < 3; i++) {
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
          ...curlGate(`${BASE}/`),
          `${BASE}/`,
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      if (/HTTP\/2 103/.test(r.stdout ?? '')) return 'HTTP/2 103 received';
    }
    throw new Skip('Vercel does not send 103 Early Hints; browsers use the Link preload headers instead');
  },
});

check({
  id: 'images',
  area: 'performance',
  title: 'next/image through Vercel Image Optimization',
  async run() {
    const original = await fetch(`${BASE}/e2e-assets/pattern.png`, { headers: { 'user-agent': BROWSER_UA } });
    const originalBytes = (await original.arrayBuffer()).byteLength;
    const page = await get('/images');
    const src = /<img[^>]+id="hero"[^>]+src="([^"]+)"|<img[^>]+src="([^"]+)"[^>]+id="hero"/.exec(page.body);
    const imageUrl = (src?.[1] ?? src?.[2] ?? '').replace(/&amp;/g, '&');
    assert(imageUrl.startsWith('/_next/image?'), `next/image src ${imageUrl}`);
    const optimized = await fetch(`${BASE}/_next/image?url=%2Fe2e-assets%2Fpattern.png&w=64&q=75`, {
      headers: { 'user-agent': BROWSER_UA, accept: 'image/avif,image/webp,image/*' },
    });
    const optimizedBytes = (await optimized.arrayBuffer()).byteLength;
    assert(optimized.status === 200, `/_next/image ${optimized.status}`);
    const type = optimized.headers.get('content-type') ?? '';
    assert(/image\/(avif|webp)/.test(type), `content-type ${type}`);
    assert(optimizedBytes < originalBytes, 'optimized is smaller');
    return `png ${originalBytes} B → ${type} ${optimizedBytes} B · ${vercelCache(optimized.headers)}`;
  },
});

check({
  id: 'rate-limit',
  area: 'security',
  title: 'Rate limit (Upstash: exact; otherwise per instance): 5/min then 429 with Retry-After',
  async run() {
    const health = JSON.parse((await api('/_hypdriv/health')).body) as { capabilities: string[] };
    const store = health.capabilities.find((c) => c.startsWith('rate limiting')) ?? 'rate limiting: ?';
    const statuses: number[] = [];
    let limited: Headers | null = null;
    for (let i = 0; i < 8; i++) {
      const r = await api('/api/limited');
      statuses.push(r.status);
      if (r.status === 429) limited = r.headers;
    }
    assert(limited, `no 429 in ${statuses.join(',')} (${store})`);
    assert(limited.get('retry-after'), 'Retry-After');
    return `${statuses.join(',')} · retry-after ${limited.get('retry-after')} · ${store}`;
  },
});

check({
  id: 'rate-limit-waf',
  area: 'security',
  title: 'Vercel WAF rate-limit rule through @vercel/firewall (5/60 s, then 429)',
  async run() {
    let rule = 'rule not checked';
    if (TOKEN && TEAM && PROJECT) {
      const fw = await vercel<{
        rules?: Array<{
          name: string;
          active: boolean;
          conditionGroup: Array<{ conditions: Array<{ type: string; value?: unknown }> }>;
        }>;
      }>('GET', `/v1/security/firewall/config/active?projectId=${PROJECT}`);
      const r = fw.json.rules?.find((x) =>
        x.conditionGroup.some((g) =>
          g.conditions.some((c) => c.type === 'rate_limit_api_id' && c.value === 'hypdriv-e2e-waf'),
        ),
      );
      if (!r) throw new Skip('no WAF rule for @vercel/firewall id "hypdriv-e2e-waf" (run provision)');
      rule = `${r.name} (${r.active ? 'active' : 'inactive'})`;
    }
    const statuses: number[] = [];
    let limited: { headers: Headers; body: string } | null = null;
    for (let i = 0; i < 9; i++) {
      const r = await api('/api/limited-waf');
      statuses.push(r.status);
      if (r.status === 429) limited = { headers: r.headers, body: r.body };
    }
    assert(limited, `no 429 in ${statuses.join(',')} · ${rule}`);
    assert(limited.headers.get('retry-after'), 'Retry-After from the HypDriv policy');
    return `${statuses.join(',')} · ${rule}`;
  },
});

check({
  id: 'botid',
  area: 'security',
  title:
    'BotID classifies a script without the challenge headers as a bot (bypassed behind Deployment Protection)',
  async run() {
    const r = await api('/api/botid', { method: 'POST' });
    assert(r.status === 200, `status ${r.status}`);
    const j = JSON.parse(r.body) as {
      verdict: { isBot: boolean; bypassed?: boolean; reason?: string } | null;
    };
    assert(j.verdict, 'verifyBotId() returned null: botid is not registered');
    // BotID deliberately skips requests that carry Vercel's automation bypass (a private deployment): the
    // verdict is then `bypassed`, which is the correct answer for the runner's own traffic.
    if (env.VERCEL_AUTOMATION_BYPASS_SECRET && j.verdict.bypassed)
      return `bypassed for the automation bypass (private deployment) · reason ${j.verdict.reason}`;
    assert(j.verdict.isBot, `verdict ${JSON.stringify(j.verdict)}`);
    return `isBot ${j.verdict.isBot} · reason ${j.verdict.reason}`;
  },
});

check({
  id: 'botid-browser',
  area: 'security',
  title: 'BotID: initBotId() attaches the challenge headers in a real browser',
  slow: true,
  async run() {
    let pw: PlaywrightLike;
    try {
      pw = createRequire(import.meta.url)('playwright') as PlaywrightLike;
    } catch {
      throw new Skip('needs Playwright (require("playwright"))');
    }
    const browser = await pw.chromium.launch();
    try {
      // Headless Chromium announces itself as HeadlessChrome, which the bot shield blocks on documents
      // (definitely automated): browse with a regular Chrome user agent, as a visitor would.
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      });
      await gateBrowser(context);
      const page = await context.newPage();
      const violations: string[] = [];
      page.on('console', (m) => {
        if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text().slice(0, 140));
      });
      const res = await page.goto(`${BASE}/botid`, { waitUntil: 'domcontentloaded' });
      assert(res?.status() === 200, `page ${res?.status()}`);
      // A selector, not a predicate: the page's CSP (no 'unsafe-eval') rejects string evaluation.
      await page.waitForSelector('#botid:not(:empty)', { timeout: 30_000 });
      const text = (await page.textContent('#botid')) ?? '';
      assert(!text.startsWith('error'), text);
      const j = JSON.parse(text) as {
        verdict: { isBot: boolean; isHuman: boolean; reason?: string } | null;
        challengeHeaders: string[];
      };
      assert(j.verdict, 'verdict returned');
      assert(j.challengeHeaders.length, `no BotID challenge header on the request (${text})`);
      assert(!violations.length, `CSP violations: ${violations.join(' | ')}`);
      return `headers ${j.challengeHeaders.join(',')} · headless Chromium → isHuman ${j.verdict.isHuman} (${j.verdict.reason})`;
    } finally {
      await browser.close();
    }
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
    const ok = await api(`/api/echo?n=4&run=${RUN}`);
    assert(ok.status === 200 && JSON.parse(ok.body).doubled === 8, `valid → ${ok.status} ${ok.body}`);
    const etag = ok.headers.get('etag');
    assert(etag, 'ETag');
    const notModified = await api(`/api/echo?n=4&run=${RUN}`, { headers: { 'if-none-match': etag } });
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
  title: 'Geo and request id from Vercel’s request headers',
  async run() {
    const r = await api('/api/geo');
    const g = JSON.parse(r.body) as {
      geo: Record<string, unknown> | null;
      country: string;
      runner: string;
      requestId: string;
    };
    assert(g.country && g.requestId, r.body);
    assert(g.geo && (g.geo.city || g.geo.region || g.geo.latitude), `geo ${JSON.stringify(g.geo)}`);
    return `${g.country} · ${String(g.geo.city ?? '')} ${String(g.geo.region ?? '')} · runner ${g.runner}`;
  },
});

check({
  id: 'hypfetch',
  area: 'api',
  title: 'hypFetch outbound request; the timeout holds and retries once (E_TIMEOUT)',
  async run() {
    // How the function reaches external hosts (DNS, raw fetch, event-loop lag): context for the result.
    const net = JSON.parse((await api('/api/fetch?mode=net&host=www.cloudflare.com')).body) as {
      dns: string;
      fetch: string;
      timerLagMs: number;
    };
    const t = await api('/api/fetch?mode=timeout');
    const timeout = JSON.parse(t.body) as { error?: string; attempts: number[]; ms: number };
    assert(t.status === 502 && timeout.error === 'E_TIMEOUT', `timeout mode → ${t.status} ${t.body}`);
    assert(timeout.attempts.join(',') === '0,1', `attempts ${timeout.attempts.join(',')}`);
    // Two 1.5 s attempts plus a short backoff: far below the upstream's 8 s.
    assert(timeout.ms < 6000, `gave up after ${timeout.ms} ms`);
    const r = await api('/api/fetch');
    const f = JSON.parse(r.body) as {
      status?: number;
      error?: string;
      attempts: number[];
      headersMs?: number;
      ms: number;
    };
    assert(
      r.status === 200 && f.status === 200,
      `external call → ${r.status} ${r.body.slice(0, 200)} · net probe: dns ${net.dns} · fetch ${net.fetch} · timer lag ${net.timerLagMs} ms`,
    );
    // How the platform fetch treats abort signals (informational: hypFetch no longer depends on it).
    const probe = await api('/api/fetch?mode=signal');
    const p = JSON.parse(probe.body) as Record<'init' | 'request', { outcome: string; ms: number }>;
    return `cloudflare.com ${f.status} in ${f.headersMs} ms · slow upstream → E_TIMEOUT after ${timeout.ms} ms (attempts ${timeout.attempts.join(',')}) · platform fetch honours a 1 s signal: init ${p.init.outcome}, Request ${p.request.outcome}`;
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
  id: 'global-config-redirects',
  area: 'routing',
  title: 'Redirect rules from Global Config apply without a redeploy',
  slow: true,
  async run() {
    const path = `/gc-redirect-${RUN}`;
    await globalConfigSet('redirects', [{ from: path, to: '/tagged', status: 302 }]);
    const started = Date.now();
    try {
      const r = await poll(
        `a 302 on ${path}`,
        async () => {
          const x = await get(path);
          return x.status === 302 ? x : null;
        },
        90_000,
        2000,
      );
      return `302 → ${r.headers.get('location')} after ${Math.round((Date.now() - started) / 1000)} s`;
    } finally {
      await globalConfigSet('redirects', null);
    }
  },
});

check({
  id: 'global-config-flags',
  area: 'routing',
  title: 'Feature flags from Global Config flip without a redeploy',
  slow: true,
  async run() {
    await globalConfigSet('flags', { e2eBanner: { default: true } });
    const started = Date.now();
    let on = 0;
    try {
      await poll(
        'banner-on',
        async () => (await get(`/flags?f=${Date.now()}`)).body.includes('banner-on'),
        90_000,
        2000,
      );
      on = Date.now() - started;
    } finally {
      await globalConfigSet('flags', null);
    }
    await poll(
      'banner-off again',
      async () => (await get(`/flags?f=${Date.now()}`)).body.includes('banner-off'),
      90_000,
      2000,
    );
    return `banner-off → banner-on (${Math.round(on / 1000)} s) → banner-off`;
  },
});

check({
  id: 'global-config-maintenance',
  area: 'routing',
  title: 'Maintenance mode from Global Config (503 + Retry-After, bypass paths stay up)',
  exclusive: true,
  async run() {
    await globalConfigSet('maintenance', { enabled: true, message: `e2e ${RUN}` });
    let detail = '';
    try {
      const r = await poll(
        'a 503 maintenance page',
        async () => {
          const x = await get(`/flags?m=${Date.now()}`);
          return x.status === 503 ? x : null;
        },
        90_000,
        2000,
      );
      assert(r.headers.get('retry-after') === '120', `retry-after ${r.headers.get('retry-after')}`);
      assert(r.body.includes(`e2e ${RUN}`), 'message from Global Config');
      // A CDN-cached page must not keep serving while the site is down for maintenance.
      const cached = await get('/tagged');
      assert(cached.status === 503, `cached /tagged → ${cached.status} (${vercelCache(cached.headers)})`);
      const bypass = await api('/api/geo');
      assert(bypass.status === 200, `bypass path → ${bypass.status}`);
      detail = '503 + Retry-After 120 (also on CDN-cached pages) · /api/** bypassed';
    } finally {
      await globalConfigSet('maintenance', null);
    }
    await poll(
      'the site back up',
      async () => (await get(`/flags?m=${Date.now()}`)).status === 200,
      90_000,
      2000,
    );
    return `${detail} · back to 200`;
  },
});

check({
  id: 'cron',
  area: 'jobs',
  title: 'Vercel Cron: registered, triggered by Vercel, CRON_SECRET enforced, schedule reaches the job',
  slow: true,
  async run() {
    const anonymous = await api('/api/jobs/tick');
    assert(anonymous.status === 401 || anonymous.status === 403, `without CRON_SECRET → ${anonymous.status}`);
    const wrong = await api('/api/jobs/tick', { headers: { authorization: 'Bearer wrong' } });
    assert(wrong.status === 401 || wrong.status === 403, `wrong secret → ${wrong.status}`);
    const out = ['401 without / with a wrong secret'];
    if (CRON_SECRET) {
      // A manual call with the secret but without Vercel's schedule header: the job still learns its
      // schedule from hypdriv.config (jobs.cron).
      const manual = await api('/api/jobs/tick', { headers: { authorization: `Bearer ${CRON_SECRET}` } });
      assert(manual.status === 200, `with CRON_SECRET → ${manual.status} ${manual.body}`);
      const r = JSON.parse(manual.body) as { job: string; result?: { cron?: string | null } };
      assert(r.job === 'tick' && r.result?.cron === '17 7 * * *', `manual run saw ${manual.body}`);
      out.push(`200 with CRON_SECRET (job ${r.job}, cron "${r.result.cron}")`);
    }
    if (!(TOKEN && TEAM && PROJECT && deploymentId)) {
      if (!CRON_SECRET) throw new Skip('needs CRON_SECRET or the Vercel API to trigger the job');
      return out.join(' · ');
    }
    const d = await vercel<{ crons?: Array<{ path: string; schedule: string }> }>(
      'GET',
      `/v13/deployments/${deploymentId}`,
    );
    const cron = d.json.crons?.find((c) => c.path === '/api/jobs/tick');
    assert(cron, `cron not registered on the deployment (${JSON.stringify(d.json.crons ?? [])})`);
    out.push(`registered "${cron.schedule}"`);
    // A real Vercel Cron invocation (what `vercel crons run` does): Vercel calls the route with CRON_SECRET
    // and x-vercel-cron-schedule.
    const { lines, attempt } = await confirmLogged(
      'the marker of the Vercel-triggered cron run',
      async () => {
        const since = Date.now();
        const r = await vercel<{ invocationAt?: number }>('POST', `/v1/projects/${PROJECT}/crons/run`, {
          path: cron.path,
          schedule: cron.schedule,
        });
        assert(r.status === 200, `crons/run ${r.status} ${JSON.stringify(r.json)}`);
        return since;
      },
      (l, since) => l.timestampInMs >= since - 5000 && markers('cron', (m) => m.cron === cron.schedule)(l),
      { waitMs: 45_000 },
    );
    out.push(
      `Vercel-triggered run reached the job with cron "${String(lines[0]!.data?.cron)}" (try ${attempt})`,
    );
    return out.join(' · ');
  },
});

check({
  id: 'queue',
  area: 'jobs',
  title: 'Vercel Queues: delivery, redelivery with attempts 1,2, retry "none" acknowledges',
  slow: true,
  async run() {
    needLogs();
    const job = (id: string) => (l: LogLine) => markers('job', (d) => d.id === id)(l);
    const attemptsOf = (id: string) =>
      logLines
        .filter(job(id))
        .map((l) => Number(l.data?.attempt))
        .sort((a, b) => a - b);
    const enqueue = async (body: Record<string, unknown>) => {
      const r = await signed('/api/enqueue', body);
      assert(r.status === 200 && r.json.transport === 'queue', `enqueue ${r.status} ${r.text}`);
    };
    // Outcomes travel through the best-effort runtime-logs stream: a part whose line went missing is repeated
    // with a fresh id (up to three rounds); a part that was observed is never repeated.
    const done: Partial<Record<'ok' | 'retry' | 'once', string>> = {};
    for (let round = 1; round <= 3 && Object.keys(done).length < 3; round++) {
      const ids = { ok: `ok-${RUN}-${round}`, retry: `retry-${RUN}-${round}`, once: `once-${RUN}-${round}` };
      if (!done.ok) await enqueue({ id: ids.ok });
      if (!done.retry) await enqueue({ id: ids.retry, failTimes: 1 });
      if (!done.once) await enqueue({ id: ids.once, queue: 'jobs-once' });
      await Promise.all([
        done.ok
          ? null
          : waitLogs('the ok job', job(ids.ok), 60_000).then(
              (l) => (done.ok = `ok in ${String(l[0]!.data?.latencyMs)} ms`),
              () => undefined,
            ),
        done.retry
          ? null
          : waitLogs(
              'the retried job (attempt 2, done)',
              (l) => job(ids.retry)(l) && l.data?.status === 'done',
              90_000,
            ).then(
              (l) => {
                const attempts = attemptsOf(ids.retry);
                // Attempt 1's line may be the lost one; attempt 2 being `done` already proves the redelivery.
                assert(attempts.includes(2), `retry attempts ${attempts.join(',')}`);
                done.retry = `retry attempts ${attempts.join(',')} (done after ${String(l[0]!.data?.latencyMs)} ms)`;
              },
              (err: Error) => {
                if (!/timed out/.test(err.message)) throw err;
              },
            ),
        done.once
          ? null
          : waitLogs('the jobs-once delivery', job(ids.once), 60_000).then(
              async () => {
                // A redelivery would arrive after the 5 s retry delay: give it time to (not) show up.
                await sleep(20_000);
                const attempts = attemptsOf(ids.once);
                assert(attempts.join(',') === '1', `retry "none" attempts ${attempts.join(',')}`);
                done.once = 'retry "none" acknowledged after attempt 1';
              },
              (err: Error) => {
                if (!/timed out/.test(err.message)) throw err;
              },
            ),
      ]);
    }
    const missing = (['ok', 'retry', 'once'] as const).filter((k) => !done[k]);
    assert(!missing.length, `no log line for: ${missing.join(', ')} after 3 rounds`);
    return `${done.ok} · ${done.retry} · ${done.once}`;
  },
});

check({
  id: 'live-polling',
  area: 'live',
  title: 'Live channels without Durable Objects: polling mode end to end',
  async run() {
    const subscribe = await api('/_hypdriv/live/e2e', { headers: { accept: 'text/event-stream' } });
    assert(subscribe.status === 503, `subscribe → ${subscribe.status}`);
    const body = JSON.parse(subscribe.body) as { transport: string; pollIntervalMs: number };
    assert(body.transport === 'polling', `transport ${body.transport}`);
    assert(subscribe.headers.get('retry-after'), 'Retry-After');
    const events = await api('/_hypdriv/live/e2e/events');
    assert(events.status === 200, `events ${events.status}`);
    assert((JSON.parse(events.body) as { transport: string }).transport === 'none', events.body);
    const published = await signed('/api/publish', { channel: 'e2e', type: 'message', data: { run: RUN } });
    assert(published.status === 200, `publish ${published.status}`);
    assert(
      published.json.delivered === false && published.json.transport === 'none',
      `publish ${published.text}`,
    );
    return `subscribe 503 (poll every ${body.pollIntervalMs} ms) · events transport none · publish reports not delivered`;
  },
});

check({
  id: 'vitals-log',
  area: 'observability',
  title: 'Web Vitals beacons land in the runtime logs',
  slow: true,
  async run() {
    const { lines, attempt } = await confirmLogged(
      'the vitals log line',
      async (n) => {
        const pathname = `/vitals-${RUN}-${n}`;
        const res = await fetch(`${BASE}/_hypdriv/vitals`, {
          method: 'POST',
          headers: { ...API_HEADERS, 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify({
            name: 'LCP',
            value: 1234,
            rating: 'good',
            id: `v-${RUN}-${n}`,
            pathname,
            ts: Date.now(),
          }),
        });
        assert(res.status === 204 || res.status === 202 || res.status === 200, `beacon ${res.status}`);
        return pathname;
      },
      (l, pathname) => l.message.includes(pathname),
    );
    const d = lines[0]!.data ?? {};
    return `vitals ${String(d.name)} ${String(d.value)} ${String(d.rating)} · country ${String(d.country ?? '?')} (try ${attempt})`;
  },
});

check({
  id: 'observability',
  area: 'observability',
  title: 'Spans and structured logs from the proxy and the functions in the runtime logs',
  slow: true,
  async run() {
    needLogs();
    const since = Date.now();
    await get(`/flags?obs=${RUN}`);
    await api(`/api/geo?obs=${RUN}`);
    const spans = await waitLogs(
      'span lines',
      (l) => l.timestampInMs >= since - 5000 && l.data?.type === 'span',
      90_000,
    );
    const names = [...new Set(spans.map((l) => String(l.data?.name)))].slice(0, 6);
    const requests = logLines.filter(
      (l) => l.timestampInMs >= since - 5000 && l.requestPath.startsWith('/flags'),
    );
    return `${spans.length} span(s): ${names.join(', ')} · ${requests.length} line(s) for /flags (sources ${[...new Set(requests.map((l) => l.source))].join(', ')})`;
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
const logStatus = await startLogs();
if (!args.json) console.log(`runtime logs: ${logStatus}`);
const results: Result[] = [];
const print = (r: Result) => {
  if (!args.json)
    console.log(
      `${r.status === 'pass' ? '✓' : r.status === 'skip' ? '–' : '✗'} ${r.id.padEnd(26)} ${r.detail}`,
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
stopLogs();
if (args.logs)
  writeFileSync(args.logs, logLines.map((l) => JSON.stringify(l)).join('\n') + (logLines.length ? '\n' : ''));
const order = new Map(selected.map((c, i) => [c.id, i]));
results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
const summary = {
  url: BASE,
  deployment: deploymentId,
  startedAt: new Date(startedAt).toISOString(),
  durationMs: Date.now() - startedAt,
  pass: results.filter((r) => r.status === 'pass').length,
  fail: results.filter((r) => r.status === 'fail').length,
  skip: results.filter((r) => r.status === 'skip').length,
  logLines: logLines.length,
  results,
};
writeFileSync(args.report ?? 'e2e-report.json', `${JSON.stringify(summary, null, 2)}\n`);
if (args.json) console.log(JSON.stringify(summary, null, 2));
else
  console.log(
    `\n${summary.pass} passed · ${summary.fail} failed · ${summary.skip} skipped · ${Math.round(summary.durationMs / 1000)} s · ${logLines.length} log line(s) read`,
  );
process.exit(summary.fail ? 1 : 0);
