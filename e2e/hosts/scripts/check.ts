/**
 * Live checks for a deployed HypDriv Vite-host example (any framework, any platform):
 *
 *   pnpm -F @hypdriv/e2e-hosts check --url https://example.dev --framework astro \
 *     --static / --dynamic /ssr --api /api/hello --rate-limit 5 [--asset-cache immutable]
 *
 * What it verifies: `/_hypdriv/health` (framework, runner), the security preset and a CSP on a prerendered
 * page and on a dynamic page, that every inline and external script of each page is allowed by its policy
 * (hash or nonce — the nonce must be the policy's and fresh per request on dynamic pages), request ids and
 * Server-Timing, the bot shield (an automation user agent gets 403), rate limiting on the API (a 429 with
 * `Retry-After` within the configured limit), HTTP → HTTPS, and immutable caching of content-hashed assets.
 *
 * Gateways in front of private test deployments are passed with the same variables `hypdriv audit` reads:
 * `VERCEL_AUTOMATION_BYPASS_SECRET`, `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET`, `HYPDRIV_ACCESS_HEADERS`
 * (sent over HTTPS to the checked host only, never printed).
 */
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    framework: { type: 'string' },
    static: { type: 'string', multiple: true },
    dynamic: { type: 'string', multiple: true },
    api: { type: 'string' },
    'rate-limit': { type: 'string' },
    'expect-runner': { type: 'string' },
    'no-https-check': { type: 'boolean', default: false },
    'no-bot-check': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const BASE = (args.url ?? '').replace(/\/+$/, '');
if (!BASE) {
  console.error('usage: check --url <base> --framework <name> [--static /] [--dynamic /ssr] [--api /api/x] [--rate-limit n]');
  process.exit(2);
}
const HOST = new URL(BASE).host;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const env = process.env;

function gateHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET) out['x-vercel-protection-bypass'] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
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

async function get(
  path: string,
  init: { ua?: string; headers?: Record<string, string>; redirect?: RequestRedirect; base?: string } = {},
): Promise<{ status: number; headers: Headers; body: string; url: string }> {
  const url = new URL(path, `${init.base ?? BASE}/`);
  const headers: Record<string, string> = {
    'user-agent': init.ua ?? UA,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    ...(init.headers ?? {}),
  };
  if (url.protocol === 'https:' && url.host === HOST) for (const [k, v] of Object.entries(GATE)) headers[k] ??= v;
  const res = await fetch(url, { headers, redirect: init.redirect ?? 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text(), url: url.href };
}

/**
 * A request with exactly the given headers (Node's fetch adds Fetch Metadata such as `sec-fetch-mode: cors`,
 * which a scraper does not send).
 */
function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string> }> {
  const url = new URL(path, `${BASE}/`);
  const all: Record<string, string> = { ...headers };
  if (url.protocol === 'https:' && url.host === HOST) for (const [k, v] of Object.entries(GATE)) all[k] ??= v;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method: 'GET', headers: all }, (res) => {
      res.resume();
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  if (!args.json) console.log(`${ok ? '✓' : '✗'} ${name.padEnd(28)} ${detail}`);
}
async function step(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    record(name, true, await fn());
  } catch (err) {
    record(name, false, (err as Error).message);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Directives of a policy (first policy when several are joined). */
function directives(policy: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of (policy ?? '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), values);
  }
  return out;
}

interface ScriptTag {
  attrs: string;
  content: string;
  src: string | null;
  nonce: string | null;
  type: string | null;
}

function scripts(html: string): ScriptTag[] {
  const out: ScriptTag[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] ?? '';
    const attr = (name: string) =>
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)?.slice(1).find((v) => v !== undefined) ?? null;
    out.push({ attrs, content: m[2] ?? '', src: attr('src'), nonce: attr('nonce'), type: attr('type') });
  }
  return out;
}

/** Whether a script tag is allowed by the script-src of a policy (hash or nonce; 'self' for external without strict-dynamic). */
function allowed(tag: ScriptTag, scriptSrc: string[]): boolean {
  const type = (tag.type ?? '').toLowerCase();
  // Data blocks are never executed.
  if (type && !['module', 'text/javascript', 'application/javascript', 'speculationrules', 'importmap'].includes(type))
    return true;
  const strictDynamic = scriptSrc.includes("'strict-dynamic'");
  if (tag.nonce && scriptSrc.includes(`'nonce-${tag.nonce}'`)) return true;
  if (tag.src) return !strictDynamic && scriptSrc.includes("'self'") && !/^https?:\/\//.test(tag.src);
  const hash = `'sha256-${createHash('sha256').update(tag.content).digest('base64')}'`;
  if (scriptSrc.includes(hash)) return true;
  return scriptSrc.includes("'unsafe-inline'") && !scriptSrc.some((s) => s.startsWith("'sha") || s.startsWith("'nonce-"));
}

function checkPolicy(page: { headers: Headers; body: string }, label: string): { mode: string; nonce: string | null } {
  const enforced = page.headers.get('content-security-policy');
  const reportOnly = page.headers.get('content-security-policy-report-only');
  const policy = enforced ?? reportOnly;
  assert(policy, `${label}: no Content-Security-Policy header`);
  assert(!enforced || !/,\s*default-src/i.test(enforced), `${label}: two policies joined in one header`);
  const scriptSrc = directives(policy).get('script-src') ?? directives(policy).get('default-src') ?? [];
  const nonce = scriptSrc.find((s) => s.startsWith("'nonce-"))?.slice(7, -1) ?? null;
  const tags = scripts(page.body);
  const blocked = tags.filter((t) => !allowed(t, scriptSrc));
  if (blocked.length)
    throw new Error(
      `${label}: ${blocked.length}/${tags.length} script(s) not allowed by the policy (first: <script${blocked[0]!.attrs.slice(0, 80)}>)`,
    );
  return { mode: page.headers.get('x-hypdriv-csp') ?? (nonce ? 'nonce' : 'hash'), nonce };
}

function checkSecurityHeaders(headers: Headers, label: string): void {
  const missing = ['x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy'].filter(
    (h) => !headers.has(h),
  );
  if (BASE.startsWith('https://') && !headers.has('strict-transport-security')) missing.push('strict-transport-security');
  assert(!missing.length, `${label}: missing ${missing.join(', ')}`);
}

const framework = (args.framework ?? '').toLowerCase();

await step('health', async () => {
  const res = await get('/_hypdriv/health', { headers: { accept: 'application/json'} });
  assert(res.status === 200, `HTTP ${res.status}`);
  const json = JSON.parse(res.body) as { ok?: boolean; framework?: string; runner?: string; target?: string; routes?: number };
  assert(json.ok === true, 'ok !== true');
  const label = (json.framework ?? '').toLowerCase().replace(/\s+/g, '');
  if (framework) assert(label.includes(framework.replace(/-/g, '')), `framework "${json.framework}" (expected ${framework})`);
  if (args['expect-runner']) assert(json.runner === args['expect-runner'], `runner ${json.runner}`);
  return `${json.framework} · runner ${json.runner} · target ${json.target} · ${json.routes} routes`;
});

for (const path of args.static ?? []) {
  await step(`static ${path}`, async () => {
    const page = await get(path);
    assert(page.status === 200, `HTTP ${page.status}`);
    checkSecurityHeaders(page.headers, path);
    const { mode } = checkPolicy(page, path);
    return `CSP ${mode}, ${scripts(page.body).length} script(s) allowed, security headers present`;
  });
}

let assetChecked = false;
for (const path of args.dynamic ?? []) {
  await step(`dynamic ${path}`, async () => {
    const a = await get(path);
    assert(a.status === 200, `HTTP ${a.status}`);
    checkSecurityHeaders(a.headers, path);
    assert(a.headers.get('x-request-id'), 'no x-request-id');
    assert(a.headers.get('server-timing'), 'no Server-Timing');
    const first = checkPolicy(a, path);
    const b = await get(path);
    const second = checkPolicy(b, path);
    if (first.nonce) assert(first.nonce !== second.nonce, 'nonce repeated across requests');
    return `CSP ${first.mode}${first.nonce ? ' (fresh nonce per request)' : ''}, request id ${a.headers.get('x-request-id')!.slice(0, 8)}…`;
  });
  if (!assetChecked) {
    assetChecked = true;
    await step('hashed asset caching', async () => {
      const page = await get(path);
      const src =
        scripts(page.body).find((t) => t.src && !/^https?:\/\//.test(t.src))?.src ??
        /<link[^>]+rel="?(?:stylesheet|modulepreload)"?[^>]+href="([^"]+)"/i.exec(page.body)?.[1] ??
        /<link[^>]+href="([^"]+)"[^>]+rel="?(?:stylesheet|modulepreload)"?/i.exec(page.body)?.[1];
      assert(src, 'no local script or stylesheet referenced');
      const res = await get(src, { headers: { accept: '*/*'} });
      assert(res.status === 200, `${src}: HTTP ${res.status}`);
      const cc = res.headers.get('cache-control') ?? '';
      assert(/immutable|max-age=31536000/.test(cc), `${src}: cache-control "${cc}"`);
      return `${src} → ${cc}`;
    });
  }
}

if (!args['no-bot-check'] && (args.dynamic?.length || args.static?.length)) {
  await step('bot shield', async () => {
    const path = args.dynamic?.[0] ?? args.static![0]!;
    const res = await rawGet(path, { 'user-agent': 'curl/8.9.1', accept: 'text/html' });
    assert(res.status === 403, `automation UA got HTTP ${res.status}`);
    return `curl UA → 403 (${res.headers['x-hypdriv-bot'] ?? 'blocked'})`;
  });
}

if (args.api) {
  await step(`api ${args.api}`, async () => {
    const res = await get(args.api!, { headers: { accept: 'application/json'} });
    assert(res.status === 200, `HTTP ${res.status}`);
    assert(res.headers.get('x-request-id'), 'no x-request-id');
    return `200 ${res.headers.get('content-type') ?? ''}`;
  });
  const limit = Number(args['rate-limit'] ?? 0);
  if (limit > 0) {
    await step('rate limit', async () => {
      const statuses: number[] = [];
      let retryAfter: string | null = null;
      for (let i = 0; i < limit + 3; i++) {
        const res = await get(args.api!, { headers: { accept: 'application/json'} });
        statuses.push(res.status);
        if (res.status === 429) {
          retryAfter = res.headers.get('retry-after');
          break;
        }
      }
      assert(statuses.includes(429), `no 429 in ${statuses.length} requests (${statuses.join(',')})`);
      assert(retryAfter, '429 without Retry-After');
      return `429 after ${statuses.length - 1} request(s), Retry-After ${retryAfter}`;
    });
  }
}

if (!args['no-https-check'] && BASE.startsWith('https://')) {
  await step('http → https', async () => {
    const res = await get('/', { base: BASE.replace(/^https:/, 'http:') });
    assert([301, 302, 307, 308].includes(res.status), `HTTP ${res.status}`);
    assert((res.headers.get('location') ?? '').startsWith('https://'), `location ${res.headers.get('location')}`);
    return `${res.status} → ${res.headers.get('location')}`;
  });
}

const failed = results.filter((r) => !r.ok);
if (args.json) console.log(JSON.stringify({ url: BASE, framework, results, failed: failed.length }, null, 2));
else console.log(`\n${results.length - failed.length} passed · ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
