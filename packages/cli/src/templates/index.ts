/**
 * File templates written by `hypdriv init`. They mirror `examples/basic` in the Hypdriv repository
 * so a scaffolded project and the reference example never drift apart.
 */

export interface TemplateOptions {
  /** Worker / site name (package.json name, scope stripped). */
  name: string;
  /** Scaffold the Purser section of the config. */
  purser: boolean;
  /** Tokens module for the Purser section (project relative). */
  purserTokens?: string;
  /** Files live under `src/` (proxy.ts imports the config with `../`). */
  srcDir: boolean;
  /** Cron jobs already declared in an existing config (for the wrangler template). */
  crons?: string[];
  /** Deployment target (default `cloudflare`). */
  platform?: 'cloudflare' | 'vercel' | 'node';
}

/** Sanitises a package name into a Worker name (`@acme/shop` → `acme-shop`). */
export function workerName(packageName: string | null | undefined, fallback = 'next-app'): string {
  const raw = (packageName ?? fallback).replace(/^@/, '').replace(/\//g, '-');
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54);
  return cleaned || fallback;
}

export function hypdrivConfigTemplate(o: TemplateOptions): string {
  const purser = o.purser
    ? `  purser: {
    tokens: '${o.purserTokens ?? 'lib/tokens.ts'}',
    src: ['app', 'components', 'lib'],
    out: 'app/purser.css',
    theme: {
      axes: {
        mode: {
          classes: { light: null, dark: 'dark' },
          default: 'light',
          clientHint: { hint: 'prefers-color-scheme', values: { dark: 'dark', light: 'light' } },
        },
      },
    },
  },
`
    : `  // Purser CSS (pnpm add @avonao/purser): see docs/guides/purser.md
  // purser: { tokens: 'lib/tokens.ts', src: ['app', 'components', 'lib'], out: 'app/purser.css' },
`;
  return `import { defineConfig } from 'hypdriv';

// Every section is optional; defaults are documented in docs/guides/configuration.md.
export default defineConfig({
  site: { name: '${o.name}' /* , origin: 'https://www.example.com' */ },
  security: {
    // Allow third parties with shorthands instead of rewriting directives:
    // csp: { allow: { scripts: ['https://js.stripe.com'], frames: ['https://js.stripe.com'] } },
    rateLimit: [{ id: 'api', match: '/api/**', limit: 120, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  cache: {
    edge: {
      // Static routes are cached automatically (inferred policies); add explicit policies for more:
      // policies: [{ id: 'blog', match: '/blog/**', ttl: '10m', swr: '1d', tags: ['blog'] }],
    },
  },
  performance: {
    earlyHints: true,
    speculation: { prerender: { eagerness: 'moderate', topN: 3 } },
  },
  observe: { tracing: { exporter: 'console' }, vitals: { sink: 'log' } },
  // flags: { definitions: { newHero: { description: 'New landing hero', default: false } } },
  // jobs: { cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } } },${o.platform === 'vercel' ? ' // + `hypdriv doctor --fix` syncs vercel.json crons' : ''}
  budgets: { routes: { '/**': { js: '300kb' } }${(o.platform ?? 'cloudflare') === 'cloudflare' ? ", worker: { gzip: '3mb' }" : ''} },
${purser}});
`;
}

export function workerTemplate(): string {
  return `import { createWorker } from 'hypdriv/cloudflare';
import config from './hypdriv.config';

// Hypdriv's Durable Objects (optional bindings; see wrangler.jsonc).
export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from 'hypdriv/durable-objects';
// Keep OpenNext's Durable Objects available to existing bindings.
export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from './.open-next/worker.js';

export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),
});
`;
}

export function proxyTemplate(o: Pick<TemplateOptions, 'srcDir'>): string {
  const configImport = o.srcDir ? '../hypdriv.config' : './hypdriv.config';
  return `import { createProxy } from 'hypdriv/proxy';
import hypdrivConfig from '${configImport}';

// Runs the Hypdriv stages on \`next dev\` / \`next start\`. Inside the Cloudflare Worker the shell has already
// run them, so this proxy passes requests straight through there.
export default createProxy(hypdrivConfig);

// Next.js reads this statically: keep it a literal (same as \`matcher\` from 'hypdriv/proxy').
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\\\.ico|robots\\\\.txt|sitemap\\\\.xml|.*\\\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|js|map|txt|xml|json)$).*)',
    '/_hypdriv/:path*',
  ],
};
`;
}

export function instrumentationTemplate(o: Pick<TemplateOptions, 'srcDir'>): string {
  const configImport = o.srcDir ? '../hypdriv.config' : './hypdriv.config';
  return `import { createInstrumentation } from 'hypdriv/instrumentation';
import config from '${configImport}';

export const { register, onRequestError } = createInstrumentation({ config });
`;
}

export const HEADERS_RULE = `/_next/static/*
  Cache-Control: public,max-age=31536000,immutable
`;

export function headersTemplate(): string {
  return HEADERS_RULE;
}

/** `.env.example` for Vercel / Node deployments (Vercel env vars mirror these names). */
export function envExampleTemplate(o: { crons: boolean }): string {
  return `# Copy to .env.local for \`next dev\`; on Vercel set them with \`vercel env add <NAME>\`.
# Replace both with throwaway values of 32+ random bytes (openssl rand -base64 32). Production secrets are never in files:
# wrangler secret put HYPDRIV_SESSION_SECRET / HYPDRIV_INTERNAL_SECRET.
HYPDRIV_SESSION_SECRET=replace-with-openssl-rand-base64-32-output
HYPDRIV_INTERNAL_SECRET=replace-with-another-openssl-rand-base64-32
${o.crons ? '' : '# '}CRON_SECRET=change-me-16-chars-min
# CACHE_PURGE_API_TOKEN=
# TURNSTILE_SECRET_KEY=
`;
}

export function devVarsExampleTemplate(): string {
  return `NEXTJS_ENV=development
HYPDRIV_SESSION_SECRET=change-me-32-bytes-minimum-please-really
HYPDRIV_INTERNAL_SECRET=change-me-too
# CACHE_PURGE_ZONE_ID=
# CACHE_PURGE_API_TOKEN=
# TURNSTILE_SECRET_KEY=
`;
}

/** First day of the current month (UTC): always a valid, recent compatibility date. */
export function defaultCompatibilityDate(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

export function wranglerTemplate(o: TemplateOptions & { compatibilityDate: string }): string {
  const crons = o.crons?.length ? `\n  "triggers": { "crons": ${JSON.stringify(o.crons)} },` : '';
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${o.name}",
  "main": "hypdriv.worker.ts",
  "compatibility_date": "${o.compatibilityDate}",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "observability": { "enabled": true },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "${o.name}" }],${crons}
  // Optional Hypdriv upgrades. Each binding unlocks a capability (docs/guides/cloudflare.md):
  // "kv_namespaces": [{ "binding": "HYPDRIV_KV", "id": "<create with: wrangler kv namespace create HYPDRIV_KV>" }],
  // "durable_objects": { "bindings": [
  //   { "name": "HYPDRIV_CHANNEL", "class_name": "HypDrivChannel" },
  //   { "name": "HYPDRIV_LIMITER", "class_name": "HypDrivLimiter" },
  //   { "name": "HYPDRIV_INDEX", "class_name": "HypDrivIndex" }
  // ] },
  // "migrations": [{ "tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel", "HypDrivLimiter", "HypDrivIndex"] }],
  // "analytics_engine_datasets": [{ "binding": "HYPDRIV_ANALYTICS", "dataset": "${o.name.replace(/-/g, '_')}" }],
  // "ratelimits": [{ "name": "HYPDRIV_RATE_LIMIT", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } }]
}
`;
}

/** Scripts added to package.json (the audit targets the platform's local preview server). */
export function scriptsTemplate(
  platform: 'cloudflare' | 'vercel' | 'node' = 'cloudflare',
): Record<string, string> {
  if (platform === 'cloudflare') {
    return {
      'cf-typegen': 'wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts',
      'hypdriv:doctor': 'hypdriv doctor',
      'hypdriv:analyze': 'hypdriv analyze',
      'hypdriv:audit': 'hypdriv audit all --url http://localhost:8787',
    };
  }
  return {
    'hypdriv:doctor': 'hypdriv doctor',
    'hypdriv:analyze': 'hypdriv analyze',
    'hypdriv:audit': 'hypdriv audit all --url http://localhost:3000',
  };
}

/** How to compose an existing proxy with Hypdriv (printed when proxy.ts already exists). */
export function proxyCompositionHint(srcDir: boolean): string {
  const configImport = srcDir ? '../hypdriv.config' : './hypdriv.config';
  return `import { createProxy } from 'hypdriv/proxy';
import hypdrivConfig from '${configImport}';

const hypdriv = createProxy(hypdrivConfig);

export default async function proxy(request, event) {
  // Your existing logic can run before or after Hypdriv's stages:
  // const own = await existingProxy(request, event); if (own) return own;
  return hypdriv(request, event);
}
// Keep \`config\` a literal object (Next.js reads it statically; re-exporting \`matcher\` is rejected):
export const config = { matcher: ['/((?!_next/static|_next/image|favicon\\\\.ico).*)', '/_hypdriv/:path*'] };`;
}

/** Manual wrangler.toml change printed when the config is TOML. */
export function wranglerTomlHint(crons: string[]): string {
  const lines = [
    'main = "hypdriv.worker.ts"',
    'compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]',
    '',
    '[observability]',
    'enabled = true',
  ];
  if (crons.length) lines.push('', '[triggers]', `crons = ${JSON.stringify(crons)}`);
  return lines.join('\n');
}
