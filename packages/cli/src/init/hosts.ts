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
  /** More config files a host registers in (e.g. `vite.config.*` next to `svelte.config.js`). */
  extraConfigFiles?: string[];
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

export interface ConfigEntry {
  element: string;
  importLine: string;
  from: string;
  position?: 'first' | 'last';
  property?: string;
}

/**
 * Registers entries in arrays of the framework's config file (`plugins` in `vite.config.*`, `integrations` in
 * `astro.config.*`, `modules` in `nuxt.config.*`), creating the file from `fallback` when the project has none
 * that matches `file`.
 */
export function registerInConfig(
  ctx: HostContext,
  entries: ConfigEntry[],
  o: { file: RegExp; fallback: { path: string; content: string }; property?: string },
): void {
  const candidates = [ctx.project.framework.configFile, ...(ctx.extraConfigFiles ?? [])].filter(
    (f): f is string => Boolean(f) && o.file.test(f as string),
  );
  const file = candidates[0];
  if (!file) {
    ctx.items.push({
      path: o.fallback.path,
      action: 'create',
      reason: 'config with HypDriv',
      content: o.fallback.content,
    });
    return;
  }
  let content = ctx.read(file);
  const reasons: string[] = [];
  for (const e of entries) {
    const property = e.property ?? o.property ?? 'plugins';
    const r = addToConfigArray(content, {
      property,
      element: e.element,
      importLine: e.importLine,
      importFrom: e.from,
      position: e.position ?? 'last',
    });
    if (!r.changed && /no exported config|could not parse/.test(r.reason)) {
      ctx.items.push({
        path: rel(ctx.project.root, file),
        action: 'manual',
        reason: r.reason,
        hint: `${entries.map((x) => x.importLine).join('\n')}\n// ${property}: [${entries.map((x) => x.element).join(', ')}]`,
      });
      return;
    }
    if (r.changed) {
      content = r.content;
      reasons.push(e.element);
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
      : { path: rel(ctx.project.root, file), action: 'skip', reason: 'already registered' },
  );
}

/** Registers plugins in a `vite.config.*` (creating it when the project has none). */
export function registerVitePlugins(
  ctx: HostContext,
  plugins: ConfigEntry[],
  fallback: { path: string; content: string },
): void {
  registerInConfig(ctx, plugins, { file: /vite\.config\./, fallback, property: 'plugins' });
}

/** Creates (or checks) a Worker entry file. */
export function planWorkerEntry(ctx: HostContext, main: string, template: string, uses: RegExp): void {
  const entry = join(ctx.project.root, main);
  if (!existsSync(entry))
    ctx.items.push({
      path: main.replace(/^\.\//, ''),
      action: 'create',
      reason: 'Worker entry: the HypDriv shell around the app (jobs, Durable Objects)',
      content: template,
    });
  else if (!uses.test(readFileSync(entry, 'utf8')))
    ctx.items.push({
      path: main,
      action: 'manual',
      reason: 'existing Worker entry; wrap it with the HypDriv shell',
      hint: template,
    });
  else ctx.items.push({ path: main, action: 'skip', reason: 'uses the HypDriv shell' });
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
      planWorkerEntry(ctx, main, viteWorkerTemplate(), /assetsWorker|createWorker/);
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

/** `src/worker.ts` for Astro on Cloudflare: the HypDriv shell around `@astrojs/cloudflare`'s handler. */
export function astroWorkerTemplate(): string {
  return `/// <reference types="@hypdriv/astro/virtual" />
// HypDriv's Worker shell around Astro's Cloudflare handler: the pipeline runs for every request that reaches the
// Worker (prerendered pages through env.ASSETS included); the HypDriv middleware inside Astro passes through.
import config from 'virtual:hypdriv/config';
import { handle } from '@astrojs/cloudflare/handler';
import { createWorker } from '@hypdriv/cloudflare';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

type AstroHandle = (request: Request, env: unknown, ctx: unknown) => Promise<Response>;

export default createWorker({
  config,
  manifest: () => import('virtual:hypdriv/manifest'),
  app: async () => ({ fetch: (request, env, ctx) => (handle as AstroHandle)(request, env, ctx) }),
});
`;
}

export const ASTRO_SPEC: HostSpec = {
  framework: 'astro',
  packages: (platform) =>
    platform === 'cloudflare'
      ? ['@hypdriv/astro', '@hypdriv/core', '@hypdriv/cloudflare']
      : ['@hypdriv/astro', '@hypdriv/core'],
  install: (platform) => ({
    dependencies: [
      platform === 'cloudflare'
        ? '@astrojs/cloudflare'
        : platform === 'vercel'
          ? '@astrojs/vercel'
          : '@astrojs/node',
    ],
    ...(platform === 'cloudflare' ? { devDependencies: ['wrangler', '@cloudflare/workers-types'] } : {}),
  }),
  register(ctx) {
    registerInConfig(
      ctx,
      [{ element: 'hypdriv()', importLine: "import hypdriv from '@hypdriv/astro';", from: '@hypdriv/astro' }],
      {
        file: /astro\.config\./,
        property: 'integrations',
        fallback: {
          path: 'astro.config.mjs',
          content: `import hypdriv from '@hypdriv/astro';\nimport { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  integrations: [hypdriv()],\n});\n`,
        },
      },
    );
    const source = ctx.project.framework.configFile ? ctx.read(ctx.project.framework.configFile) : '';
    if (!/\badapter\s*:/.test(source))
      ctx.notes.push(
        `Astro needs an adapter for on-demand rendering: ${ctx.platform === 'cloudflare' ? '`adapter: cloudflare()` (@astrojs/cloudflare)' : ctx.platform === 'vercel' ? '`adapter: vercel()` (@astrojs/vercel)' : "`adapter: node({ mode: 'standalone', staticHeaders: true })` (@astrojs/node)"} in astro.config.`,
      );
    if (ctx.platform === 'node' && !/staticHeaders\s*:\s*true/.test(source))
      ctx.notes.push(
        "@astrojs/node: set `staticHeaders: true` so prerendered pages are served with HypDriv's headers (dist/_headers.json).",
      );
    if (/security\s*:\s*\{[^}]*csp/.test(source))
      ctx.notes.push(
        "Astro's security.csp is on: Astro owns the policy and HypDriv's CSP stays off (one policy per response).",
      );
  },
  platform(ctx) {
    if (ctx.platform !== 'cloudflare') return;
    const configured = ctx.project.wrangler.config?.main ?? null;
    const main = configured ?? './src/worker.ts';
    planWorkerEntry(ctx, main, astroWorkerTemplate(), /createWorker/);
    planHostWrangler(ctx, {
      main: configured ? null : main,
      durableObjects: true,
      assets: JSON.stringify({
        binding: 'ASSETS',
        directory: './dist/client',
        run_worker_first: ['/*', '!/_astro/*'],
      }),
      template: () =>
        `{\n  "$schema": "node_modules/wrangler/config-schema.json",\n  "name": "${ctx.name}",\n  "main": "./src/worker.ts",\n  "compatibility_date": "${defaultCompatibilityDate(ctx.now)}",\n  "compatibility_flags": ["nodejs_compat"],\n  // HypDriv's Worker shell runs for every request except content-hashed assets, prerendered pages included.\n  "assets": { "binding": "ASSETS", "directory": "./dist/client", "run_worker_first": ["/*", "!/_astro/*"] },\n  "observability": { "enabled": true },\n  "durable_objects": { "bindings": ${JSON.stringify(HYPDRIV_DO)} },\n  "migrations": ${JSON.stringify(HYPDRIV_MIGRATION)}\n}\n`,
    });
  },
  scripts: (platform) => ({
    'hypdriv:doctor': 'hypdriv doctor',
    'hypdriv:audit': `hypdriv audit all --url http://localhost:${platform === 'cloudflare' ? '8787' : '4321'}`,
  }),
};

/** Specs per framework; frameworks without one get the generic plan (config + package + manual registration). */
export const HOST_SPECS: Partial<Record<FrameworkName, HostSpec>> = {
  vite: VITE_SPEC,
  astro: ASTRO_SPEC,
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
