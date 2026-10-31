/**
 * Creates (idempotently) the Vercel resources the live suite needs in your team and writes the git-ignored
 * files that point the runner at them:
 *
 *   VERCEL_TOKEN=… VERCEL_TEAM_ID=team_… \
 *   pnpm -F @hypdriv/e2e-vercel provision --prefix acme-hypdriv --domain e2e-vercel.acme.dev
 *
 * Resources: the project `<prefix>-vercel-e2e` (Next.js, root directory `e2e/vercel`, functions in `iad1`,
 * Vercel Authentication on every deployment with a Protection Bypass for Automation — test deployments are
 * private; `--public` limits protection to previews and generated URLs),
 * its environment variables (session, internal and cron secrets, Turnstile keys, the Global Config
 * connection), a Global Config store `<prefix>-vercel-e2e` with a read token for the app, the WAF
 * rate-limit rule behind `vercel.firewall.rateLimitRules.waf` (`@vercel/firewall` id `hypdriv-e2e-waf`,
 * 5 requests / 60 s per key), and optionally a custom domain (not needed: the suite runs against
 * `<project>.vercel.app` through the bypass). Files: `<prefix>.vercel.secrets.local.json`
 * (mode 600), `<prefix>.vercel.e2e.local.env` (source it, then `pnpm e2e`) and `.vercel/project.json` at the
 * repository root (so `vercel build` / `vercel deploy --prebuilt` target the project).
 *
 * The Vercel token is used here and by the runner only; the deployment receives a Global Config read token,
 * never the account token. Nothing secret is printed.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    prefix: { type: 'string' },
    domain: { type: 'string' },
    'turnstile-site-key': { type: 'string' },
    'turnstile-secret-key': { type: 'string' },
    'root-directory': { type: 'string', default: 'e2e/vercel' },
    region: { type: 'string', default: 'iad1' },
    dir: { type: 'string' },
    link: { type: 'boolean', default: true },
    /** Leave production reachable without Vercel Authentication (default: every deployment is private). */
    public: { type: 'boolean', default: false },
  },
});

const TOKEN = process.env.VERCEL_TOKEN ?? '';
const TEAM = process.env.VERCEL_TEAM_ID ?? '';
const prefix = args.prefix ?? '';
if (!TOKEN || !TEAM || !/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/.test(prefix)) {
  console.error(
    'usage: VERCEL_TOKEN=… VERCEL_TEAM_ID=team_… provision --prefix <lowercase-name> [--domain <host>] [--turnstile-site-key … --turnstile-secret-key …]',
  );
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '..', '..');
const dir = args.dir ? resolve(args.dir) : appDir;
const name = `${prefix}-vercel-e2e`;
const WAF_RULE_ID = 'hypdriv-e2e-waf';

async function vercel<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const url = new URL(`https://api.vercel.com${path}`);
  url.searchParams.set('teamId', TEAM);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
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

function ok<T>(r: { status: number; json: T }, what: string): T {
  if (r.status >= 400) {
    const error = (r.json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new Error(`${what}: HTTP ${r.status} ${error?.code ?? ''} ${error?.message ?? ''}`.trim());
  }
  return r.json;
}

const log = (what: string, detail: string) => console.log(`✓ ${what.padEnd(18)} ${detail}`);

// Project
interface Project {
  id: string;
  name: string;
  rootDirectory: string | null;
  serverlessFunctionRegion: string | null;
}
let project = (await vercel<Project>('GET', `/v9/projects/${name}`)).json;
if (!project?.id) {
  project = ok(
    await vercel<Project>('POST', '/v11/projects', {
      name,
      framework: 'nextjs',
      rootDirectory: args['root-directory'],
      serverlessFunctionRegion: args.region,
    }),
    'create project',
  );
} else if (
  project.rootDirectory !== args['root-directory'] ||
  project.serverlessFunctionRegion !== args.region
) {
  project = ok(
    await vercel<Project>('PATCH', `/v9/projects/${project.id}`, {
      rootDirectory: args['root-directory'],
      serverlessFunctionRegion: args.region,
    }),
    'update project',
  );
}
log('project', `${project.name} (${project.id}) · root ${args['root-directory']} · ${args.region}`);

// Private by default: Vercel Authentication on every deployment, production and custom domains included
// (available on Hobby), plus a Protection Bypass for Automation secret for the runner and `hypdriv audit`.
interface Protected {
  ssoProtection?: { deploymentType: string } | null;
  protectionBypass?: Record<string, { scope?: string }> | null;
}
const protection = ok(
  await vercel<Protected>('PATCH', `/v9/projects/${project.id}`, {
    ssoProtection: args.public ? { deploymentType: 'all_except_custom_domains' } : { deploymentType: 'all' },
  }),
  'deployment protection',
);
const findBypass = (p: Protected) =>
  Object.entries(p.protectionBypass ?? {}).find(([, v]) => v?.scope === 'automation-bypass')?.[0];
let bypass = findBypass(protection);
if (!bypass)
  bypass = findBypass(
    ok(
      await vercel<Protected>('PATCH', `/v1/projects/${project.id}/protection-bypass`, {
        generate: { note: 'HypDriv live suite runner and audits' },
      }),
      'protection bypass',
    ),
  );
if (!bypass) throw new Error('protection bypass: no automation secret returned');
log(
  'protection',
  `Vercel Authentication on ${args.public ? 'previews and generated URLs' : 'every deployment'} · automation bypass ready`,
);

// Secrets (kept on disk, mode 600, never printed)
mkdirSync(dir, { recursive: true });
const secretsFile = join(dir, `${prefix}.vercel.secrets.local.json`);
const secrets: Record<string, string> = existsSync(secretsFile)
  ? (JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>)
  : {};
secrets.HYPDRIV_SESSION_SECRET ??= randomBytes(48).toString('base64url');
secrets.HYPDRIV_INTERNAL_SECRET ??= randomBytes(48).toString('base64url');
secrets.CRON_SECRET ??= randomBytes(32).toString('base64url');
if (args['turnstile-site-key']) secrets.TURNSTILE_SITE_KEY = args['turnstile-site-key'];
if (args['turnstile-secret-key']) secrets.TURNSTILE_SECRET_KEY = args['turnstile-secret-key'];
// Not a project variable: Vercel exposes it to the deployment itself; kept here for the runner and audits.
secrets.VERCEL_AUTOMATION_BYPASS_SECRET = bypass;

// Global Config store + a read token for the app
interface Store {
  id: string;
  slug: string;
}
const stores = ok(await vercel<Store[]>('GET', '/v1/global-config'), 'list Global Config stores');
const store =
  stores.find((s) => s.slug === name) ??
  ok(await vercel<Store>('POST', '/v1/global-config', { slug: name }), 'create Global Config store');
const tokenLabel = `${name}-read`.slice(0, 52);
const tokens = ok(
  await vercel<Array<{ id: string; label: string; token: string }>>(
    'GET',
    `/v1/global-config/${store.id}/tokens`,
  ),
  'list Global Config tokens',
);
const readToken =
  tokens.find((t) => t.label === tokenLabel)?.token ??
  ok(
    await vercel<{ token: string }>('POST', `/v1/global-config/${store.id}/token`, { label: tokenLabel }),
    'create Global Config token',
  ).token;
secrets.GLOBAL_CONFIG = `https://edge-config.vercel.com/${store.id}?token=${readToken}`;
log('Global Config', `${store.slug} (${store.id}) · read token "${tokenLabel}"`);

writeFileSync(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
chmodSync(secretsFile, 0o600);
log('secrets file', `${secretsFile} (mode 600)`);

// Environment variables: sensitive (write-only) for production and preview
const envBody = Object.entries(secrets)
  .filter(([key]) => key !== 'VERCEL_AUTOMATION_BYPASS_SECRET')
  .map(([key, value]) => ({
    key,
    value,
    type: key === 'TURNSTILE_SITE_KEY' ? 'plain' : 'sensitive',
    target: ['production', 'preview'],
  }));
ok(
  await vercel('POST', `/v10/projects/${project.id}/env?upsert=true`, envBody),
  'upsert environment variables',
);
log('environment', `${envBody.map((e) => e.key).join(', ')} (production, preview)`);

// WAF rate-limit rule for @vercel/firewall
interface FirewallRule {
  id: string;
  name: string;
  conditionGroup: Array<{ conditions: Array<{ type: string; value?: unknown }> }>;
}
const ruleName = `${name}-waf`;
const ruleValue = {
  name: ruleName,
  description: `HypDriv live suite: @vercel/firewall rate limit "${WAF_RULE_ID}" (5 / 60 s per key)`,
  active: true,
  conditionGroup: [{ conditions: [{ type: 'rate_limit_api_id', op: 'eq', value: WAF_RULE_ID }] }],
  action: {
    mitigate: {
      action: 'rate_limit',
      rateLimit: { algo: 'fixed_window', window: 60, limit: 5, keys: ['ip'], action: 'rate_limit' },
      actionDuration: null,
    },
  },
};
const active = await vercel<{ rules?: FirewallRule[]; firewallEnabled?: boolean }>(
  'GET',
  `/v1/security/firewall/config/active?projectId=${project.id}`,
);
const existingRule = active.json?.rules?.find(
  (r) =>
    r.name === ruleName ||
    r.conditionGroup.some((g) =>
      g.conditions.some((c) => c.type === 'rate_limit_api_id' && c.value === WAF_RULE_ID),
    ),
);
if (active.status === 404 || !active.json?.rules) {
  ok(
    await vercel('PUT', `/v1/security/firewall/config?projectId=${project.id}`, {
      firewallEnabled: true,
      rules: [ruleValue],
    }),
    'create firewall configuration',
  );
} else if (!existingRule) {
  ok(
    await vercel('PATCH', `/v1/security/firewall/config?projectId=${project.id}`, {
      action: 'rules.insert',
      id: null,
      value: ruleValue,
    }),
    'insert WAF rule',
  );
} else {
  ok(
    await vercel('PATCH', `/v1/security/firewall/config?projectId=${project.id}`, {
      action: 'rules.update',
      id: existingRule.id,
      value: ruleValue,
    }),
    'update WAF rule',
  );
}
log('WAF rule', `${ruleName} → @vercel/firewall "${WAF_RULE_ID}"`);

// Custom domain
if (args.domain) {
  const domains = ok(
    await vercel<{ domains: Array<{ name: string; verified: boolean }> }>(
      'GET',
      `/v9/projects/${project.id}/domains`,
    ),
    'list domains',
  ).domains;
  if (!domains.some((d) => d.name === args.domain))
    ok(await vercel('POST', `/v10/projects/${project.id}/domains`, { name: args.domain }), 'add domain');
  const dns = (
    await vercel<{ recommendedCNAME?: Array<{ rank: number; value: string }>; misconfigured?: boolean }>(
      'GET',
      `/v6/domains/${args.domain}/config?projectIdOrName=${project.id}`,
    )
  ).json;
  const target =
    [...(dns?.recommendedCNAME ?? [])].sort((a, b) => a.rank - b.rank)[0]?.value.replace(/\.$/, '') ??
    'cname.vercel-dns.com';
  log(
    'domain',
    `${args.domain} → CNAME ${target}${dns?.misconfigured === false ? ' (configured)' : ' (create it; DNS only if another CDN fronts the zone)'}`,
  );
}

// `vercel build` / `vercel deploy --prebuilt` from the repository root target this project
if (args.link) {
  const linkDir = join(repoRoot, '.vercel');
  mkdirSync(linkDir, { recursive: true });
  writeFileSync(
    join(linkDir, 'project.json'),
    `${JSON.stringify({ projectId: project.id, orgId: TEAM }, null, 2)}\n`,
  );
  log('vercel link', `${join(linkDir, 'project.json')} (git-ignored)`);
}

// Environment for the suite
const url = args.domain ? `https://${args.domain}` : `https://${name}.vercel.app`;
const envFile = join(dir, `${prefix}.vercel.e2e.local.env`);
const secretRef = (key: string) => `$(node -p "require('${secretsFile}').${key}")`;
writeFileSync(
  envFile,
  [
    `export E2E_URL=${url}`,
    `export E2E_VERCEL_PROJECT=${project.id}`,
    `export E2E_GLOBAL_CONFIG_ID=${store.id}`,
    `export VERCEL_TEAM_ID=${TEAM}`,
    ...(secrets.TURNSTILE_SITE_KEY ? [`export E2E_TURNSTILE_SITE_KEY=${secrets.TURNSTILE_SITE_KEY}`] : []),
    `export HYPDRIV_INTERNAL_SECRET=${secretRef('HYPDRIV_INTERNAL_SECRET')}`,
    `export VERCEL_AUTOMATION_BYPASS_SECRET=${secretRef('VERCEL_AUTOMATION_BYPASS_SECRET')}`,
    `export CRON_SECRET=${secretRef('CRON_SECRET')}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
log('suite environment', `${envFile} (add VERCEL_TOKEN from your shell)`);
console.log(`
Next (from the repository root):
  vercel pull --yes --environment=production && vercel build --prod
  vercel deploy --prebuilt --prod
  cd ${args['root-directory']} && source ${envFile} && pnpm e2e`);
