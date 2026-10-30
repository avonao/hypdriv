/**
 * Creates (idempotently) the Cloudflare resources the live suite needs in your account and writes the
 * git-ignored files that point the app at them:
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
 *   pnpm -F @hypdriv/e2e-cloudflare provision --prefix acme-hypdriv --domain e2e.acme.dev --zone <zone id>
 *
 * Resources: KV namespace, R2 bucket (location hint `enam`, US-first), the jobs queue and its dead-letter
 * queue, a Turnstile widget for the domain. Files: `wrangler.<prefix>.local.jsonc` (deploy with
 * `opennextjs-cloudflare deploy -c …`), `<prefix>.secrets.local.json` (pass with `--secrets-file`, mode 600)
 * and `<prefix>.e2e.local.env` (source it, then `pnpm e2e`). After the first deploy,
 * `provision --prefix … --tag <tag>` tags the Worker (script settings) for inventory.
 *
 * Cache purges need `CACHE_PURGE_API_TOKEN` (a token with Zone → Cache Purge on the zone): add it to the
 * secrets file yourself; this script never creates or prints tokens.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    prefix: { type: 'string' },
    domain: { type: 'string' },
    zone: { type: 'string' },
    tag: { type: 'string' },
    'rate-limit-namespace': { type: 'string' },
    'tail-producer': { type: 'string' },
    dir: { type: 'string' },
  },
});

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID ?? '';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? '';
const prefix = args.prefix ?? '';
if (!ACCOUNT || !TOKEN || !/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/.test(prefix)) {
  console.error(
    'usage: CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… provision --prefix <lowercase-name> [--domain <host>] [--zone <id>] [--tag <tag>]',
  );
  process.exit(2);
}
const dir = args.dir ?? process.cwd();
const worker = `${prefix}-e2e`;

interface CfResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  result_info?: { page: number; total_pages: number };
}

async function cf<T>(method: string, path: string, body?: unknown): Promise<CfResponse<T>> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as CfResponse<T>;
  if (!json.success && res.status !== 404)
    throw new Error(`${method} ${path}: ${json.errors?.map((e) => `${e.code} ${e.message}`).join('; ')}`);
  return json;
}

async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const r = await cf<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=100`);
    out.push(...(r.result ?? []));
    if (!r.result_info || page >= r.result_info.total_pages) return out;
  }
}

const log = (what: string, detail: string) => console.log(`✓ ${what.padEnd(18)} ${detail}`);

if (args.tag) {
  const r = await cf<{ tags: string[] | null }>('GET', `workers/scripts/${worker}/script-settings`);
  const tags = [...new Set([...(r.result?.tags ?? []), args.tag])];
  await cf('PATCH', `workers/scripts/${worker}/script-settings`, { tags });
  log('worker tags', `${worker}: ${tags.join(', ')}`);
  process.exit(0);
}

// KV namespace
const kvTitle = `${prefix}-e2e-kv`;
const namespaces = await all<{ id: string; title: string }>('storage/kv/namespaces');
const kv =
  namespaces.find((n) => n.title === kvTitle) ??
  (await cf<{ id: string; title: string }>('POST', 'storage/kv/namespaces', { title: kvTitle })).result;
log('KV namespace', `${kv.title} (${kv.id})`);

// R2 bucket for the OpenNext incremental cache
const bucket = `${prefix}-e2e-cache`;
const existingBucket = await cf<{ name: string }>('GET', `r2/buckets/${bucket}`);
if (!existingBucket.success) await cf('POST', 'r2/buckets', { name: bucket, locationHint: 'enam' });
log('R2 bucket', `${bucket} (enam)`);

// Queues
const queues = await all<{ queue_id: string; queue_name: string }>('queues');
for (const name of [`${prefix}-e2e-jobs`, `${prefix}-e2e-jobs-dlq`]) {
  const q =
    queues.find((x) => x.queue_name === name) ??
    (await cf<{ queue_id: string; queue_name: string }>('POST', 'queues', { queue_name: name })).result;
  log('queue', `${q.queue_name} (${q.queue_id})`);
}

// Secrets (kept on disk, mode 600, never printed)
const secretsFile = join(dir, `${prefix}.secrets.local.json`);
const secrets: Record<string, string> = existsSync(secretsFile)
  ? (JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>)
  : {};
secrets.HYPDRIV_SESSION_SECRET ??= randomBytes(48).toString('base64url');
secrets.HYPDRIV_INTERNAL_SECRET ??= randomBytes(48).toString('base64url');
if (args.zone) secrets.CACHE_PURGE_ZONE_ID = args.zone;

// Turnstile widget for the domain (managed mode)
if (args.domain && !secrets.TURNSTILE_SITE_KEY) {
  const apex = args.domain.split('.').slice(-2).join('.');
  const widget = (
    await cf<{ sitekey: string; secret: string }>('POST', 'challenges/widgets', {
      name: `${prefix}-e2e`,
      domains: [apex],
      mode: 'managed',
    })
  ).result;
  secrets.TURNSTILE_SITE_KEY = widget.sitekey;
  secrets.TURNSTILE_SECRET_KEY = widget.secret;
  log('Turnstile widget', `${prefix}-e2e for ${apex} (site key ${widget.sitekey})`);
}
writeFileSync(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
chmodSync(secretsFile, 0o600);
log(
  'secrets file',
  `${secretsFile} (mode 600${secrets.CACHE_PURGE_API_TOKEN ? '' : '; add CACHE_PURGE_API_TOKEN for zone purges'})`,
);

// Wrangler configuration for this account
const strip = (t: string) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'])\/\/[^\n]*/g, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
const config = JSON.parse(strip(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8'))) as Record<
  string,
  unknown
> & {
  services: Array<{ binding: string; service: string }>;
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
  queues: {
    producers: Array<{ binding: string; queue: string }>;
    consumers: Array<{ queue: string; dead_letter_queue?: string }>;
  };
};
const rename = (q: string) => q.replace(/^hypdriv-e2e-/, `${prefix}-e2e-`);
config.name = worker;
config.services = config.services.map((s) =>
  s.binding === 'WORKER_SELF_REFERENCE' ? { ...s, service: worker } : s,
);
config.r2_buckets = config.r2_buckets.map((b) => ({ ...b, bucket_name: bucket }));
config.kv_namespaces = [{ binding: 'HYPDRIV_KV', id: kv.id }];
config.queues = {
  producers: config.queues.producers.map((p) => ({ ...p, queue: rename(p.queue) })),
  consumers: config.queues.consumers.map((c) => ({
    ...c,
    queue: rename(c.queue),
    ...(c.dead_letter_queue ? { dead_letter_queue: rename(c.dead_letter_queue) } : {}),
  })),
};
config.analytics_engine_datasets = [{ binding: 'HYPDRIV_ANALYTICS', dataset: worker.replace(/-/g, '_') }];
if (args['rate-limit-namespace'])
  config.ratelimits = [
    {
      name: 'HYPDRIV_RATE_LIMIT',
      namespace_id: args['rate-limit-namespace'],
      simple: { limit: 120, period: 60 },
    },
  ];
config.vars = { NEXTJS_ENV: 'production' };
config.workers_dev = true;
config.preview_urls = false;
if (args.domain) config.routes = [{ pattern: args.domain, custom_domain: true }];
const overlay = join(dir, `wrangler.${prefix}.local.jsonc`);
writeFileSync(
  overlay,
  `// Generated by scripts/provision.ts for ${prefix} (git-ignored)\n${JSON.stringify(config, null, 2)}\n`,
);
log('wrangler config', overlay);

// Environment for the suite
const url = args.domain ? `https://${args.domain}` : `https://${worker}.<your-subdomain>.workers.dev`;
const envFile = join(dir, `${prefix}.e2e.local.env`);
writeFileSync(
  envFile,
  [
    `export E2E_URL=${url}`,
    `export E2E_WORKER=${worker}`,
    `export E2E_KV_NAMESPACE_ID=${kv.id}`,
    `export E2E_R2_BUCKET=${bucket}`,
    `export E2E_AE_DATASET=${worker.replace(/-/g, '_')}`,
    ...(args.zone ? [`export E2E_ZONE_ID=${args.zone}`] : []),
    ...(secrets.TURNSTILE_SITE_KEY ? [`export E2E_TURNSTILE_SITE_KEY=${secrets.TURNSTILE_SITE_KEY}`] : []),
    ...(args['tail-producer'] ? [`export E2E_TAIL_PRODUCER_URL=${args['tail-producer']}`] : []),
    `export HYPDRIV_INTERNAL_SECRET=$(node -p "require('./${prefix}.secrets.local.json').HYPDRIV_INTERNAL_SECRET")`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
log('suite environment', envFile);
console.log(`
Next:
  pnpm exec opennextjs-cloudflare build -c wrangler.${prefix}.local.jsonc
  pnpm exec opennextjs-cloudflare deploy -c wrangler.${prefix}.local.jsonc --secrets-file ${prefix}.secrets.local.json
  source ${prefix}.e2e.local.env && pnpm e2e`);
