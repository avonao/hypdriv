/**
 * Private test deployments of the host examples (`examples/vite`, `examples/react-router`, …) on your own
 * Cloudflare and Vercel accounts. Idempotent; never prints a token, gate value or bypass secret.
 *
 * Cloudflare (a Worker on a custom domain of a zone you own, `workers.dev` and preview URLs off):
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… HYPDRIV_GATE=… \
 *   pnpm -F @hypdriv/e2e-hosts provision cloudflare --dir examples/vite --name acme-hypdriv-vite \
 *     --domain acme-hypdriv-vite.acme.dev --zone <zone id> [--tag hypdriv-dev] [--prefix acme-hypdriv]
 *
 *   Writes `<dir>/wrangler.<prefix>.local.jsonc` (git-ignored) from the example's wrangler config: name, custom
 *   domain, observability. Gates every host of the prefix with ONE zone WAF custom rule (the Free plan allows five):
 *   HTTPS requests without the `x-hypdriv-gate` header or `hypdriv_gate` cookie are blocked. A zone Redirect Rule
 *   sends plain HTTP for those hosts to https first, because Workers Static Assets answer before the Worker's own
 *   upgrade and HTTP requests cannot carry the gate safely. Run it before the first deploy (the hostname is gated
 *   before it resolves) and again with `--tag` afterwards to tag the Worker.
 *
 * Vercel (Deployment Protection on every deployment, an automation bypass for tooling):
 *
 *   VERCEL_TOKEN=… VERCEL_TEAM_ID=… \
 *   pnpm -F @hypdriv/e2e-hosts provision vercel --dir examples/vite --name acme-hypdriv-vite \
 *     --root-directory examples/vite --framework vite
 *
 *   Creates the project when missing, sets `ssoProtection: all`, generates the automation bypass and writes it to
 *   `<dir>/<name>.vercel.secrets.local.json` (mode 600, git-ignored) as `VERCEL_AUTOMATION_BYPASS_SECRET`.
 *
 * Then deploy (`wrangler deploy -c …` after a build with `WRANGLER_CONFIG=…`; `vercel build && vercel deploy
 * --prebuilt` from the repository root) and run `check` with `HYPDRIV_ACCESS_HEADERS="x-hypdriv-gate: …"` or
 * `VERCEL_AUTOMATION_BYPASS_SECRET` (see the README).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gateZoneHosts } from './zone-gate.ts';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    name: { type: 'string' },
    prefix: { type: 'string' },
    domain: { type: 'string' },
    zone: { type: 'string' },
    tag: { type: 'string' },
    config: { type: 'string' },
    'root-directory': { type: 'string' },
    framework: { type: 'string' },
  },
});

const NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const log = (what: string, detail: string) => console.log(`✓ ${what.padEnd(20)} ${detail}`);

function fail(message: string): never {
  console.error(`provision: ${message}`);
  process.exit(2);
}

/** JSONC → JSON (comments and trailing commas), enough for wrangler configs. */
export function parseJsonc(text: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

// ── Cloudflare ────────────────────────────────────────────────────────────────────────────────────────────────

interface CfResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

async function cloudflare(): Promise<void> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
  const gate = process.env.HYPDRIV_GATE ?? '';
  const name = args.name ?? '';
  const domain = (args.domain ?? '').toLowerCase();
  const prefix = args.prefix ?? name.replace(/-[a-z0-9]+$/, '');
  if (!account || !token) fail('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  if (!NAME.test(name)) fail('--name <worker-name> (lowercase letters, digits, dashes)');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || !args.zone)
    fail('--domain <host> --zone <zone id> are required');
  if (gate.length < 24)
    fail('set HYPDRIV_GATE to a random value of at least 24 characters (it is never printed)');
  if (!args.dir) fail('--dir <example directory>');
  const dir = resolve(args.dir);

  const api = async <T>(method: string, path: string, body?: unknown): Promise<CfResponse<T>> => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await res.json()) as CfResponse<T>;
  };
  const errors = (r: CfResponse<unknown>) => (r.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ');

  // 1. The local wrangler config.
  const source = join(
    dir,
    args.config ?? (existsSync(join(dir, 'wrangler.jsonc')) ? 'wrangler.jsonc' : 'wrangler.json'),
  );
  if (!existsSync(source)) fail(`${source} not found`);
  const cfg = parseJsonc(readFileSync(source, 'utf8'));
  cfg.name = name;
  cfg.workers_dev = false;
  cfg.preview_urls = false;
  cfg.routes = [{ pattern: domain, custom_domain: true }];
  cfg.observability = {
    enabled: true,
    head_sampling_rate: 1,
    logs: { enabled: true, invocation_logs: true },
  };
  const local = join(dir, `wrangler.${prefix}.local.jsonc`);
  writeFileSync(
    local,
    `// Local, git-ignored: ${name} on ${domain} (written by e2e/hosts provision)\n${JSON.stringify(cfg, null, 2)}\n`,
  );
  log('wrangler config', local);

  // 2–3. One gate rule and one https redirect for every host of the prefix.
  const gated = await gateZoneHosts({ token, zone: args.zone!, prefix, hosts: [domain], gate }).catch(
    (err: Error) => fail(err.message),
  );
  log('gate rule', `${gated.hosts.length} host(s): ${gated.hosts.join(', ')}`);
  log('https redirect', `${gated.hosts.length} host(s)`);

  // 4. After the first deploy: tags, and workers.dev / preview URLs confirmed off.
  const settings = await api<{ tags?: string[] | null }>(
    'GET',
    `accounts/${account}/workers/scripts/${name}/script-settings`,
  );
  if (!settings.success) {
    log('worker', `${name} not deployed yet — deploy, then run again${args.tag ? ' to tag it' : ''}`);
    return;
  }
  if (args.tag) {
    const tags = [...new Set([...(settings.result.tags ?? []), args.tag])];
    const tagged = await api('PATCH', `accounts/${account}/workers/scripts/${name}/script-settings`, {
      tags,
    });
    if (!tagged.success) fail(`tags: ${errors(tagged)}`);
    log('worker tags', tags.join(', '));
  }
  const sub = await api<{ enabled: boolean; previews_enabled: boolean }>(
    'GET',
    `accounts/${account}/workers/scripts/${name}/subdomain`,
  );
  if (sub.success && (sub.result.enabled || sub.result.previews_enabled)) {
    const off = await api('POST', `accounts/${account}/workers/scripts/${name}/subdomain`, {
      enabled: false,
      previews_enabled: false,
    });
    if (!off.success) fail(`workers.dev: ${errors(off)}`);
  }
  log('workers.dev', 'off (custom domain only)');
}

// ── Vercel ────────────────────────────────────────────────────────────────────────────────────────────────────

async function vercel(): Promise<void> {
  const token = process.env.VERCEL_TOKEN ?? '';
  const team = process.env.VERCEL_TEAM_ID ?? '';
  const name = args.name ?? '';
  if (!token) fail('set VERCEL_TOKEN');
  if (!NAME.test(name)) fail('--name <project-name>');
  if (!args.dir) fail('--dir <directory for the secrets file>');
  const query = team ? `?teamId=${encodeURIComponent(team)}` : '';
  const api = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> => {
    const res = await fetch(`https://api.vercel.com${path}${query}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as T };
  };
  type Project = {
    id: string;
    ssoProtection?: { deploymentType: string } | null;
    error?: { message: string };
  };

  let project = await api<Project>('GET', `/v9/projects/${name}`);
  if (project.status === 404) {
    project = await api<Project>('POST', '/v11/projects', {
      name,
      ...(args.framework ? { framework: args.framework } : {}),
      ...(args['root-directory'] ? { rootDirectory: args['root-directory'] } : {}),
    });
    if (project.status >= 300) fail(`create project: ${project.json.error?.message ?? project.status}`);
    log('project', `${name} created`);
  } else if (project.status >= 300) fail(`project: ${project.json.error?.message ?? project.status}`);
  else log('project', `${name} exists`);
  const id = project.json.id;

  if (project.json.ssoProtection?.deploymentType !== 'all') {
    const sso = await api<Project>('PATCH', `/v9/projects/${id}`, {
      ssoProtection: { deploymentType: 'all' },
    });
    if (sso.status >= 300) fail(`protection: ${sso.json.error?.message ?? sso.status}`);
  }
  log('protection', 'Vercel Authentication on every deployment');

  const file = join(resolve(args.dir), `${name}.vercel.secrets.local.json`);
  const existing = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>).VERCEL_AUTOMATION_BYPASS_SECRET
    : undefined;
  type Bypass = { protectionBypass?: Record<string, { scope: string }>; error?: { message: string } };
  const current = await api<Project & Bypass>('GET', `/v9/projects/${id}`);
  const known = Object.entries(current.json.protectionBypass ?? {})
    .filter(([, v]) => v.scope === 'automation-bypass')
    .map(([k]) => k);
  let secret = existing && known.includes(existing) ? existing : undefined;
  if (!secret) {
    const generated = await api<Bypass>('PATCH', `/v1/projects/${id}/protection-bypass`, {
      generate: { note: 'hypdriv e2e/hosts' },
    });
    if (generated.status >= 300) fail(`bypass: ${generated.json.error?.message ?? generated.status}`);
    secret = Object.entries(generated.json.protectionBypass ?? {}).find(
      ([k, v]) => v.scope === 'automation-bypass' && !known.includes(k),
    )?.[0];
    if (!secret) fail('bypass: no automation secret in the response');
  }
  writeFileSync(file, `${JSON.stringify({ VERCEL_AUTOMATION_BYPASS_SECRET: secret }, null, 2)}\n`);
  chmodSync(file, 0o600);
  log('automation bypass', `${file} (mode 600)`);
}

const command = positionals[0];
if (command === 'cloudflare') await cloudflare();
else if (command === 'vercel') await vercel();
else fail('usage: provision <cloudflare|vercel> … (see the header of scripts/provision.ts)');
