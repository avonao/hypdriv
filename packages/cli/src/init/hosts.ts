import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FrameworkName } from '@hypdriv/core';
import type { LoadedConfig } from '../context';
import { FRAMEWORK_LABEL, type ProjectInfo } from '../project';
import { defaultCompatibilityDate, workerName } from '../templates';
import { rel } from '../util/fs';
import { addToConfigArray } from './config-edit';
import { editPackageJson } from './package-json';
import { type InitOptions, type InitPlan, type InitPlatform, type PlanItem, planVercel } from './plan';
import { addRootKey, editWranglerJsonc, rootValueText } from './wrangler';

/**
 * `hypdriv init` for Vite hosts (ADR 0019): the HypDriv config, the integration registered in the framework's own
 * config file, and the platform files the integration needs (a Worker entry and wrangler settings on Cloudflare,
 * nothing extra on Vercel, a start script on Node). Edits are targeted text insertions; anything that cannot be
 * placed safely becomes a manual step with the exact snippet.
 */

export interface HostContext {
  project: ProjectInfo;
  platform: InitPlatform;
  name: string;
  now: Date;
  read(file: string): string;
  items: PlanItem[];
  notes: string[];
  nextSteps: string[];
}

export interface HostSpec {
  framework: FrameworkName;
  /** `@hypdriv/*` packages the app depends on. */
  packages: (platform: InitPlatform) => string[];
  /** Third-party packages to install per platform (printed as a command; versions resolve at install time). */
  install?: (platform: InitPlatform) => { dependencies?: string[]; devDependencies?: string[] };
  /** Registers the integration in the framework's config (and platform plugins it needs). */
  register: (ctx: HostContext) => void;
  /** Platform files (Worker entry, wrangler settings, Vercel config). */
  platform?: (ctx: HostContext) => void;
  scripts: (platform: InitPlatform) => Record<string, string>;
}

const HYPDRIV_DO = [
  { name: 'HYPDRIV_LIMITER', class_name: 'HypDrivLimiter' },
  { name: 'HYPDRIV_INDEX', class_name: 'HypDrivIndex' },
  { name: 'HYPDRIV_CHANNEL', class_name: 'HypDrivChannel' },
];
const HYPDRIV_MIGRATION = [
  { tag: 'hypdriv-v1', new_sqlite_classes: ['HypDrivChannel', 'HypDrivLimiter', 'HypDrivIndex'] },
];

/** `hypdriv.config.ts` for a Vite host (imports `defineConfig` from `@hypdriv/core`). */
export function hostConfigTemplate(o: { name: string; framework: FrameworkName }): string {
  return `import { defineConfig } from '@hypdriv/core';

// ${FRAMEWORK_LABEL[o.framework]} + HypDriv. Every section is optional; defaults: docs/guides/configuration.md.
export default defineConfig({
  site: { name: '${o.name}' /* , origin: 'https://www.example.com' */ },
  security: {
    // Allow third parties with shorthands instead of rewriting directives:
    // csp: { allow: { scripts: ['https://js.stripe.com'], frames: ['https://js.stripe.com'] } },
    rateLimit: [{ id: 'api', match: '/api/**', limit: 120, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  performance: {
    earlyHints: true,
    speculation: { prerender: { eagerness: 'moderate', topN: 3 } },
  },
  observe: { vitals: { sink: 'log' } },
  // flags: { definitions: { newHero: { description: 'New landing hero', default: false } } },
  budgets: { routes: { '/**': { js: '300kb' } } },
});
`;
}

/** `src/worker.ts` for a plain Vite app on Cloudflare: the static assets behind the HypDriv shell. */
export function viteWorkerTemplate(): string {
  return `/// <reference types="@hypdriv/vite/virtual" />
import { assetsWorker } from '@hypdriv/vite/worker';
import config from 'virtual:hypdriv/config';

// Rate limiting, tag index and live channels use these Durable Objects (bound in wrangler.jsonc).
export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

export default assetsWorker({
  config,
  manifest: () => import('virtual:hypdriv/manifest'),
  // Your own API next to the static app; return null to serve the assets.
  handle(request) {
    if (new URL(request.url).pathname === '/api/health') return Response.json({ ok: true });
    return null;
  },
});
`;
}

/** Whether a plain Vite project is a single-page app: one `index.html` at the root and no other entry. */
export function isSinglePageApp(root: string): boolean {
  if (!existsSync(join(root, 'index.html'))) return false;
  const html = readdirSync(root).filter((f) => f.endsWith('.html'));
  return html.length === 1;
}

export function viteWranglerTemplate(o: { name: string; compatibilityDate: string; spa: boolean }): string {
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${o.name}",
  "main": "src/worker.ts",
  "compatibility_date": "${o.compatibilityDate}",
  "compatibility_flags": ["nodejs_compat"],
  // The Worker runs first for everything except content-hashed assets, so navigations get the full pipeline.
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "${o.spa ? 'single-page-application' : '404-page'}",
    "run_worker_first": ["/*", "!/assets/*"]
  },
  "observability": { "enabled": true },
  "durable_objects": { "bindings": ${JSON.stringify(HYPDRIV_DO)} },
  "migrations": ${JSON.stringify(HYPDRIV_MIGRATION)}
}
`;
}

function viteConfigTemplate(platform: InitPlatform): string {
  const cf = platform === 'cloudflare';
  return `${cf ? "import { cloudflare } from '@cloudflare/vite-plugin';\n" : ''}import { hypdriv } from '@hypdriv/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [${cf ? 'cloudflare(), ' : ''}hypdriv()],
});
`;
}

/** Registers plugins in a `vite.config.*` (creating it when the project has none). */
export function registerVitePlugins(
  ctx: HostContext,
  plugins: Array<{ element: string; importLine: string; from: string; position?: 'first' | 'last' }>,
  fallback: { path: string; content: string },
): void {
  const file = ctx.project.framework.configFile;
  if (!file || !/vite\.config\./.test(file)) {
    ctx.items.push({
      path: fallback.path,
      action: 'create',
      reason: 'Vite config with HypDriv',
      content: fallback.content,
    });
    return;
  }
  let content = ctx.read(file);
  const reasons: string[] = [];
  for (const p of plugins) {
    const r = addToConfigArray(content, {
      property: 'plugins',
      element: p.element,
      importLine: p.importLine,
      importFrom: p.from,
      position: p.position ?? 'last',
    });
    if (!r.changed && /no exported config|could not parse/.test(r.reason)) {
      ctx.items.push({
        path: rel(ctx.project.root, file),
        action: 'manual',
        reason: r.reason,
        hint: `${plugins.map((x) => x.importLine).join('\n')}\n// plugins: [${plugins.map((x) => x.element).join(', ')}]`,
      });
      return;
    }
    if (r.changed) {
      content = r.content;
      reasons.push(p.element);
    }
  }
  ctx.items.push(
    reasons.length
      ? {
          path: rel(ctx.project.root, file),
          action: 'modify',
          reason: `register ${reasons.join(', ')}`,
          content,
        }
      : { path: rel(ctx.project.root, file), action: 'skip', reason: 'plugins registered' },
  );
}

/** Cloudflare wrangler settings for a host whose Worker entry is `main`. */
export function planHostWrangler(
  ctx: HostContext,
  o: { main: string | null; template: () => string; assets?: string; durableObjects: boolean },
): void {
  const { project } = ctx;
  const file = project.wrangler.configFile;
  if (!file) {
    ctx.items.push({
      path: 'wrangler.jsonc',
      action: 'create',
      reason: 'Worker config for HypDriv',
      content: o.template(),
    });
    return;
  }
  const path = rel(project.root, file);
  if (project.wrangler.format === 'toml') {
    ctx.items.push({
      path,
      action: 'manual',
      reason: 'wrangler.toml is not edited automatically; apply these settings',
      hint: [
        o.main ? `main = "${o.main}"` : null,
        'compatibility_flags = ["nodejs_compat"]',
        o.assets ? '[assets]\nbinding = "ASSETS"\nrun_worker_first = ["/*", "!/assets/*"]' : null,
        o.durableObjects
          ? HYPDRIV_DO.map(
              (d) => `[[durable_objects.bindings]]\nname = "${d.name}"\nclass_name = "${d.class_name}"`,
            ).join('\n')
          : null,
        '[observability]\nenabled = true',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    return;
  }
  let content = ctx.read(file);
  const changes: string[] = [];
  if (o.main) {
    const edit = editWranglerJsonc(content, { main: o.main, observability: true });
    content = edit.content;
    changes.push(...edit.changes);
  }
  if (o.assets) {
    const assets = rootValueText(content, 'assets');
    if (assets === null) {
      content = addRootKey(content, 'assets', o.assets, 'main') ?? content;
      changes.push('assets: binding ASSETS, run_worker_first for navigations');
    } else if (!/run_worker_first/.test(assets))
      ctx.notes.push(
        `${path}: add "run_worker_first": ["/*", "!/assets/*"] to "assets" so navigations run HypDriv's request stages (static pages otherwise get only the _headers rules).`,
      );
  }
  if (o.durableObjects) {
    const dos = rootValueText(content, 'durable_objects');
    if (dos === null) {
      content =
        addRootKey(content, 'durable_objects', JSON.stringify({ bindings: HYPDRIV_DO }), 'observability') ??
        content;
      changes.push('durable_objects: HypDriv limiter, tag index, channels');
      const migrations = addRootKey(
        content,
        'migrations',
        JSON.stringify(HYPDRIV_MIGRATION),
        'durable_objects',
      );
      if (migrations) content = migrations;
      else
        ctx.notes.push(
          `${path} has migrations: add { "tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel", "HypDrivLimiter", "HypDrivIndex"] }.`,
        );
    } else if (!/HypDrivLimiter/.test(dos))
      ctx.notes.push(
        `${path}: bind HypDriv's Durable Objects (HYPDRIV_LIMITER/HypDrivLimiter, HYPDRIV_INDEX/HypDrivIndex, HYPDRIV_CHANNEL/HypDrivChannel) for exact rate limits, tag purges and live channels.`,
      );
  }
  if (!/nodejs_compat/.test(rootValueText(content, 'compatibility_flags') ?? ''))
    ctx.notes.push(`${path}: HypDriv needs "compatibility_flags": ["nodejs_compat"] (AsyncLocalStorage).`);
  ctx.items.push(
    changes.length
      ? { path, action: 'modify', reason: 'HypDriv Worker settings', details: changes, content }
      : { path, action: 'skip', reason: 'already configured' },
  );
}

export const VITE_SPEC: HostSpec = {
  framework: 'vite',
  packages: (platform) =>
    platform === 'cloudflare'
      ? ['@hypdriv/vite', '@hypdriv/core', '@hypdriv/cloudflare']
      : ['@hypdriv/vite', '@hypdriv/core'],
  install: (platform) =>
    platform === 'cloudflare'
      ? { devDependencies: ['@cloudflare/vite-plugin', 'wrangler', '@cloudflare/workers-types'] }
      : {},
  register(ctx) {
    const cf = ctx.platform === 'cloudflare';
    registerVitePlugins(
      ctx,
      [
        ...(cf
          ? [
              {
                element: 'cloudflare()',
                importLine: "import { cloudflare } from '@cloudflare/vite-plugin';",
                from: '@cloudflare/vite-plugin',
                position: 'first' as const,
              },
            ]
          : []),
        {
          element: 'hypdriv()',
          importLine: "import { hypdriv } from '@hypdriv/vite';",
          from: '@hypdriv/vite',
        },
      ],
      { path: 'vite.config.ts', content: viteConfigTemplate(ctx.platform) },
    );
  },
  platform(ctx) {
    const { project } = ctx;
    if (ctx.platform === 'cloudflare') {
      const configured = project.wrangler.config?.main ?? null;
      const main = configured ?? 'src/worker.ts';
      const entry = join(project.root, main);
      if (!existsSync(entry))
        ctx.items.push({
          path: main,
          action: 'create',
          reason: 'Worker in front of the static assets (HypDriv shell, Durable Objects)',
          content: viteWorkerTemplate(),
        });
      else if (!/assetsWorker|createWorker/.test(readFileSync(entry, 'utf8')))
        ctx.items.push({
          path: main,
          action: 'manual',
          reason: 'existing Worker entry; serve the assets through HypDriv',
          hint: viteWorkerTemplate(),
        });
      else ctx.items.push({ path: main, action: 'skip', reason: 'uses the HypDriv shell' });
      const spa = isSinglePageApp(project.root);
      planHostWrangler(ctx, {
        main: configured ? null : main,
        durableObjects: true,
        assets: JSON.stringify({
          binding: 'ASSETS',
          not_found_handling: spa ? 'single-page-application' : '404-page',
          run_worker_first: ['/*', '!/assets/*'],
        }),
        template: () =>
          viteWranglerTemplate({ name: ctx.name, compatibilityDate: defaultCompatibilityDate(ctx.now), spa }),
      });
    } else if (ctx.platform === 'vercel')
      ctx.notes.push(
        'On Vercel the plugin writes .vercel/output itself (static files, HypDriv header routes, Routing Middleware); keep the Vite framework preset and `vite build` as the build command. Functions in api/ deploy alongside.',
      );
  },
  scripts: (platform) => ({
    'hypdriv:doctor': 'hypdriv doctor',
    ...(platform === 'node' ? { start: 'hypdriv serve' } : {}),
    'hypdriv:audit': `hypdriv audit all --url http://localhost:${platform === 'cloudflare' ? '4173' : '3000'}`,
  }),
};

/** Specs per framework; frameworks without one get the generic plan (config + package + manual registration). */
export const HOST_SPECS: Partial<Record<FrameworkName, HostSpec>> = {
  vite: VITE_SPEC,
};

/** The init plan for a Vite host. */
export function buildHostPlan(
  project: ProjectInfo,
  loaded: LoadedConfig | null,
  options: InitOptions & { platform: InitPlatform },
): InitPlan {
  const framework = project.framework.name as FrameworkName;
  const spec = HOST_SPECS[framework];
  const ctx: HostContext = {
    project,
    platform: options.platform,
    name: workerName(project.packageJson?.name, `${framework}-app`),
    now: options.now,
    read: (file) => readFileSync(file, 'utf8'),
    items: [],
    notes: [],
    nextSteps: [],
  };
  // 1. hypdriv.config.ts
  if (project.hypdrivConfigFile)
    ctx.items.push({ path: rel(project.root, project.hypdrivConfigFile), action: 'skip', reason: 'exists' });
  else
    ctx.items.push({
      path: 'hypdriv.config.ts',
      action: 'create',
      reason: 'HypDriv configuration with commented defaults',
      content: hostConfigTemplate({ name: ctx.name, framework }),
    });

  // 2. Registration and platform files
  if (spec) {
    spec.register(ctx);
    spec.platform?.(ctx);
  } else
    ctx.items.push({
      path: project.framework.configFile ? rel(project.root, project.framework.configFile) : 'vite.config.ts',
      action: 'manual',
      reason: `register ${project.framework.integration} (see docs/guides/${framework}.md)`,
      hint: `See docs/guides/${framework}.md for ${FRAMEWORK_LABEL[framework]}.`,
    });
  if (options.platform === 'vercel') {
    const crons = loaded
      ? Object.values(loaded.resolved.jobs.cron).map((j) => ({ path: j.path, schedule: j.cron }))
      : [];
    planVercel(project, ctx.items, ctx.notes, { crons, read: ctx.read });
  }

  // 3. package.json
  const pkgFile = join(project.root, 'package.json');
  const range = project.inHypDrivMonorepo ? 'workspace:*' : `^${options.cliVersion}`;
  const packages = spec?.packages(options.platform) ?? [
    project.framework.integration ?? '@hypdriv/vite',
    '@hypdriv/core',
  ];
  const scripts = spec?.scripts(options.platform) ?? { 'hypdriv:doctor': 'hypdriv doctor' };
  if (existsSync(pkgFile)) {
    try {
      const edit = editPackageJson(ctx.read(pkgFile), {
        scripts,
        dependencies: [
          ...packages.map((name) => ({ name, range })),
          { name: '@hypdriv/cli', range, dev: true },
        ],
      });
      ctx.items.push(
        edit.changes.length
          ? {
              path: 'package.json',
              action: 'modify',
              reason: 'scripts and dependencies',
              details: edit.changes,
              content: edit.content,
            }
          : { path: 'package.json', action: 'skip', reason: 'scripts and dependencies present' },
      );
    } catch (err) {
      ctx.items.push({
        path: 'package.json',
        action: 'manual',
        reason: `could not parse (${(err as Error).message})`,
        hint: JSON.stringify(scripts, null, 2),
      });
    }
  } else
    ctx.items.push({
      path: 'package.json',
      action: 'manual',
      reason: 'no package.json found',
      hint: JSON.stringify(scripts, null, 2),
    });

  // 4. Next steps
  const pm = project.packageManager;
  const add = pm === 'npm' ? 'npm install' : `${pm} add`;
  const install = spec?.install?.(options.platform) ?? {};
  ctx.nextSteps.push(`Install the dependencies: ${pm === 'npm' ? 'npm install' : `${pm} install`}`);
  if (install.dependencies?.length) ctx.nextSteps.push(`${add} ${install.dependencies.join(' ')}`);
  if (install.devDependencies?.length) ctx.nextSteps.push(`${add} -D ${install.devDependencies.join(' ')}`);
  ctx.nextSteps.push(
    `Build once (${options.platform === 'vercel' ? 'VERCEL=1 ' : `HYPDRIV_TARGET=${options.platform} `}vite build or your build script) so the integration writes .hypdriv/manifest.json and the platform configuration.`,
  );
  if (options.platform === 'cloudflare')
    ctx.nextSteps.push(
      'Set production secrets: `wrangler secret put HYPDRIV_SESSION_SECRET`, `wrangler secret put HYPDRIV_INTERNAL_SECRET`.',
    );
  ctx.nextSteps.push(
    `Verify: \`hypdriv doctor\`, \`hypdriv routes\` after the build, then \`hypdriv audit all --url ${options.platform === 'cloudflare' ? 'http://localhost:4173` against `vite preview`' : options.platform === 'node' ? 'http://localhost:3000` against `hypdriv serve`' : 'https://<deployment>` (VERCEL_AUTOMATION_BYPASS_SECRET for protected deployments)'}.`,
  );
  return {
    platform: options.platform,
    items: ctx.items,
    notes: ctx.notes,
    nextSteps: ctx.nextSteps,
    purser: false,
  };
}
