import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { FrameworkName } from '@hypdriv/core';
import type { LoadedConfig } from '../context';
import { FRAMEWORK_LABEL, HONO_ENTRY_FILES, type ProjectInfo } from '../project';
import { defaultCompatibilityDate, workerName } from '../templates';
import { rel } from '../util/fs';
import { addToConfigArray, wrapCallArgument, wrapPropertyValue } from './config-edit';
import { insertImport } from './next-config';
import { editPackageJson } from './package-json';
import { type InitOptions, type InitPlan, type InitPlatform, type PlanItem, planVercel } from './plan';
import { addRootKey, editWranglerJsonc, rootValueText } from './wrangler';

/**
 * `hypdriv init` for Vite hosts (ADR 0019): the Hypdriv config, the integration registered in the framework's own
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

// ${FRAMEWORK_LABEL[o.framework]} + Hypdriv. Every section is optional; defaults: docs/guides/configuration.md.
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

/** `src/worker.ts` for a plain Vite app on Cloudflare: the static assets behind the Hypdriv shell. */
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

const CONFIG_EXT_ORDER = ['ts', 'mts', 'js', 'mjs', 'cts', 'cjs'];
const extOf = (file: string) => file.slice(file.lastIndexOf('.') + 1);

export interface ConfigEntry {
  element: string;
  importLine: string;
  from: string;
  position?: 'first' | 'last';
  /** Insert right before the first element matching this. */
  before?: RegExp;
  /** Whether the element is already there (default: its callee is called in the array). */
  present?: RegExp;
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
  const inRoot = readdirSync(ctx.project.root)
    .filter((f) => o.file.test(f) && /\.(?:[cm]?[jt]s)$/.test(f))
    .sort((a, b) => CONFIG_EXT_ORDER.indexOf(extOf(a)) - CONFIG_EXT_ORDER.indexOf(extOf(b)))
    .map((f) => join(ctx.project.root, f));
  const candidates = [ctx.project.framework.configFile, ...(ctx.extraConfigFiles ?? []), ...inRoot].filter(
    (f): f is string => Boolean(f) && o.file.test(f as string),
  );
  const file = candidates[0];
  if (!file) {
    ctx.items.push({
      path: o.fallback.path,
      action: 'create',
      reason: 'config with Hypdriv',
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
      ...(e.importLine ? { importLine: e.importLine, importFrom: e.from } : {}),
      position: e.position ?? 'last',
      ...(e.before ? { before: e.before } : {}),
      ...(e.present ? { present: e.present } : {}),
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
      reason: 'Worker entry: the Hypdriv shell around the app (jobs, Durable Objects)',
      content: template,
    });
  else if (!uses.test(readFileSync(entry, 'utf8')))
    ctx.items.push({
      path: main,
      action: 'manual',
      reason: 'existing Worker entry; wrap it with the Hypdriv shell',
      hint: template,
    });
  else ctx.items.push({ path: main, action: 'skip', reason: 'uses the Hypdriv shell' });
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
      reason: 'Worker config for Hypdriv',
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
        `${path}: add "run_worker_first": ["/*", "!/assets/*"] to "assets" so navigations run Hypdriv's request stages (static pages otherwise get only the _headers rules).`,
      );
  }
  if (o.durableObjects) {
    const dos = rootValueText(content, 'durable_objects');
    if (dos === null) {
      content =
        addRootKey(content, 'durable_objects', JSON.stringify({ bindings: HYPDRIV_DO }), 'observability') ??
        content;
      changes.push('durable_objects: Hypdriv limiter, tag index, channels');
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
        `${path}: bind Hypdriv's Durable Objects (HYPDRIV_LIMITER/HypDrivLimiter, HYPDRIV_INDEX/HypDrivIndex, HYPDRIV_CHANNEL/HypDrivChannel) for exact rate limits, tag purges and live channels.`,
      );
  }
  if (!/nodejs_compat/.test(rootValueText(content, 'compatibility_flags') ?? ''))
    ctx.notes.push(`${path}: Hypdriv needs "compatibility_flags": ["nodejs_compat"] (AsyncLocalStorage).`);
  ctx.items.push(
    changes.length
      ? { path, action: 'modify', reason: 'Hypdriv Worker settings', details: changes, content }
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
        'On Vercel the plugin writes .vercel/output itself (static files, Hypdriv header routes, Routing Middleware); keep the Vite framework preset and `vite build` as the build command. Functions in api/ deploy alongside.',
      );
  },
  scripts: (platform) => ({
    'hypdriv:doctor': 'hypdriv doctor',
    ...(platform === 'node' ? { start: 'hypdriv serve' } : {}),
    'hypdriv:audit': `hypdriv audit all --url http://localhost:${platform === 'cloudflare' ? '4173' : '3000'}`,
  }),
};

/** `src/worker.ts` for Astro on Cloudflare: the Hypdriv shell around `@astrojs/cloudflare`'s handler. */
export function astroWorkerTemplate(): string {
  return `/// <reference types="@hypdriv/astro/virtual" />
// Hypdriv's Worker shell around Astro's Cloudflare handler: the pipeline runs for every request that reaches the
// Worker (prerendered pages through env.ASSETS included); the Hypdriv middleware inside Astro passes through.
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
        "@astrojs/node: set `staticHeaders: true` so prerendered pages are served with Hypdriv's headers (dist/_headers.json).",
      );
    if (/security\s*:\s*\{[^}]*csp/.test(source))
      ctx.notes.push(
        "Astro's security.csp is on: Astro owns the policy and Hypdriv's CSP stays off (one policy per response).",
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
        `{\n  "$schema": "node_modules/wrangler/config-schema.json",\n  "name": "${ctx.name}",\n  "main": "./src/worker.ts",\n  "compatibility_date": "${defaultCompatibilityDate(ctx.now)}",\n  "compatibility_flags": ["nodejs_compat"],\n  // Hypdriv's Worker shell runs for every request except content-hashed assets, prerendered pages included.\n  "assets": { "binding": "ASSETS", "directory": "./dist/client", "run_worker_first": ["/*", "!/_astro/*"] },\n  "observability": { "enabled": true },\n  "durable_objects": { "bindings": ${JSON.stringify(HYPDRIV_DO)} },\n  "migrations": ${JSON.stringify(HYPDRIV_MIGRATION)}\n}\n`,
    });
  },
  scripts: (platform) => ({
    'hypdriv:doctor': 'hypdriv doctor',
    'hypdriv:audit': `hypdriv audit all --url http://localhost:${platform === 'cloudflare' ? '8787' : '4321'}`,
  }),
};

/** Applies a text edit to a project file as one plan item (create when absent with `fallback`, manual on failure). */
export function planFileEdit(
  ctx: HostContext,
  path: string,
  edit: (source: string) => { changed: boolean; content: string; reason: string },
  o: { fallback?: string; hint: string; done?: RegExp },
): void {
  const file = join(ctx.project.root, path);
  if (!existsSync(file)) {
    if (o.fallback !== undefined)
      ctx.items.push({ path, action: 'create', reason: 'Hypdriv wiring', content: o.fallback });
    else ctx.items.push({ path, action: 'manual', reason: 'file not found', hint: o.hint });
    return;
  }
  const source = ctx.read(file);
  if (o.done?.test(source)) {
    ctx.items.push({ path, action: 'skip', reason: 'already wired' });
    return;
  }
  const r = edit(source);
  if (r.changed) ctx.items.push({ path, action: 'modify', reason: r.reason, content: r.content });
  else if (/already/.test(r.reason)) ctx.items.push({ path, action: 'skip', reason: r.reason });
  else ctx.items.push({ path, action: 'manual', reason: r.reason, hint: o.hint });
}

/** Creates a file when absent; a file without `uses` gets a manual step with the template as the hint. */
export function planNewFile(
  ctx: HostContext,
  path: string,
  content: string,
  o: { uses: RegExp; reason: string; existing?: string },
): void {
  const file = join(ctx.project.root, path);
  if (!existsSync(file)) {
    ctx.items.push({ path, action: 'create', reason: o.reason, content });
    return;
  }
  if (o.uses.test(ctx.read(file))) ctx.items.push({ path, action: 'skip', reason: 'already wired' });
  else
    ctx.items.push({
      path,
      action: 'manual',
      reason: o.existing ?? `${path} exists; wire Hypdriv in`,
      hint: content,
    });
}

const DO_EXPORTS =
  "export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';";
const cloudflarePlugin = (environment: string, extra = ''): ConfigEntry => ({
  element: `cloudflare({ viteEnvironment: { name: '${environment}'${extra} } })`,
  importLine: "import { cloudflare } from '@cloudflare/vite-plugin';",
  from: '@cloudflare/vite-plugin',
  position: 'first',
});
const wranglerJson = (o: Record<string, unknown>) => `${JSON.stringify(o, null, 2)}\n`;

export const REACT_ROUTER_SPEC: HostSpec = {
  framework: 'react-router',
  packages: (platform) =>
    platform === 'cloudflare'
      ? ['@hypdriv/react-router', '@hypdriv/core', '@hypdriv/cloudflare']
      : ['@hypdriv/react-router', '@hypdriv/core'],
  install: (platform) =>
    platform === 'cloudflare'
      ? { devDependencies: ['@cloudflare/vite-plugin', 'wrangler', '@cloudflare/workers-types'] }
      : {},
  register(ctx) {
    registerInConfig(
      ctx,
      [
        ...(ctx.platform === 'cloudflare' ? [cloudflarePlugin('ssr')] : []),
        {
          element: 'hypdriv()',
          importLine: "import { hypdriv } from '@hypdriv/react-router';",
          from: '@hypdriv/react-router',
          before: /reactRouter\s*\(/,
        },
      ],
      {
        file: /vite\.config\./,
        property: 'plugins',
        fallback: {
          path: 'vite.config.ts',
          content: `${ctx.platform === 'cloudflare' ? "import { cloudflare } from '@cloudflare/vite-plugin';\n" : ''}import { hypdriv } from '@hypdriv/react-router';\nimport { reactRouter } from '@react-router/dev/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [${ctx.platform === 'cloudflare' ? "cloudflare({ viteEnvironment: { name: 'ssr' } }), " : ''}hypdriv(), reactRouter()],\n});\n`,
        },
      },
    );
    const rrConfig = ['react-router.config.ts', 'react-router.config.js'].find((f) =>
      existsSync(join(ctx.project.root, f)),
    );
    planFileEdit(
      ctx,
      rrConfig ?? 'react-router.config.ts',
      (source) =>
        addToConfigArray(source, {
          property: 'presets',
          element: 'hypdrivPreset()',
          importLine: "import { hypdrivPreset } from '@hypdriv/react-router';",
          importFrom: '@hypdriv/react-router',
          position: 'last',
        }),
      {
        fallback: `import { hypdrivPreset } from '@hypdriv/react-router';\nimport type { Config } from '@react-router/dev/config';\n\nexport default {\n  ssr: true,\n  presets: [hypdrivPreset()],\n} satisfies Config;\n`,
        hint: "presets: [hypdrivPreset()] // import { hypdrivPreset } from '@hypdriv/react-router'",
      },
    );
    const root = ['app/root.tsx', 'app/root.jsx', 'app/root.ts'].find((f) =>
      existsSync(join(ctx.project.root, f)),
    );
    planFileEdit(
      ctx,
      root ?? 'app/root.tsx',
      (source) => {
        if (/export\s+(?:const|let|function)\s+middleware\b/.test(source))
          return {
            changed: false,
            content: source,
            reason: 'root route exports its own middleware; add hypdrivMiddleware() first',
          };
        const withImport = insertImport(
          source,
          "import { hypdrivMiddleware } from '@hypdriv/react-router/server';",
          'esm',
        );
        return {
          changed: true,
          content: `${withImport.replace(/\s*$/, '')}\n\n// Hypdriv's request stages around every route (security headers, CSP nonce, rate limiting, bot shield).\nexport const middleware = [hypdrivMiddleware()];\n`,
          reason: 'export the Hypdriv root middleware',
        };
      },
      {
        done: /hypdrivMiddleware/,
        hint: "import { hypdrivMiddleware } from '@hypdriv/react-router/server';\nexport const middleware = [hypdrivMiddleware(), /* your middleware */];",
      },
    );
    planNewFile(
      ctx,
      'app/entry.server.tsx',
      "// React Router's server entry with Hypdriv's CSP nonce on every script ServerRouter and React render.\nexport { default, streamTimeout } from '@hypdriv/react-router/entry.server';\n",
      {
        uses: /@hypdriv\/react-router/,
        reason: "server entry that hands Hypdriv's nonce to ServerRouter",
        existing:
          "app/entry.server.tsx exists; pass the request nonce to ServerRouter (or re-export Hypdriv's entry)",
      },
    );
  },
  platform(ctx) {
    if (ctx.platform === 'cloudflare') {
      const configured = ctx.project.wrangler.config?.main ?? null;
      const main = configured ?? 'workers/app.ts';
      planWorkerEntry(
        ctx,
        main,
        `/// <reference types="@hypdriv/vite/virtual" />\nimport config from 'virtual:hypdriv/config';\nimport { reactRouterWorker } from '@hypdriv/react-router/cloudflare';\n\n${DO_EXPORTS}\n\n// Hypdriv's Worker shell around React Router: prerendered pages and public files from the assets binding, the\n// rest from React Router; scheduled/queue/email dispatch Hypdriv's jobs.\nexport default reactRouterWorker({ config });\n`,
        /reactRouterWorker|createWorker/,
      );
      const assets = {
        binding: 'ASSETS',
        html_handling: 'drop-trailing-slash',
        not_found_handling: 'none',
        run_worker_first: ['/*', '!/assets/*'],
      };
      planHostWrangler(ctx, {
        main: configured ? null : main,
        durableObjects: true,
        assets: JSON.stringify(assets),
        template: () =>
          wranglerJson({
            $schema: 'node_modules/wrangler/config-schema.json',
            name: ctx.name,
            main,
            compatibility_date: defaultCompatibilityDate(ctx.now),
            compatibility_flags: ['nodejs_compat'],
            assets,
            observability: { enabled: true },
            durable_objects: { bindings: HYPDRIV_DO },
            migrations: HYPDRIV_MIGRATION,
          }),
      });
    } else if (ctx.platform === 'vercel')
      ctx.notes.push(
        "On Vercel Hypdriv writes the Build Output itself (static files, header routes, one traced function per server bundle, Routing Middleware for prerendered pages); @vercel/react-router's vercelPreset() is optional (route `config`).",
      );
  },
  scripts: (platform) => ({
    'hypdriv:doctor': 'hypdriv doctor',
    ...(platform === 'node' ? { start: 'hypdriv-react-router-serve ./build/server/index.js' } : {}),
    'hypdriv:audit': `hypdriv audit all --url http://localhost:${platform === 'cloudflare' ? '4173' : '3000'}`,
  }),
};

export const TANSTACK_START_SPEC: HostSpec = {
  framework: 'tanstack-start',
  packages: (platform) =>
    platform === 'cloudflare'
      ? ['@hypdriv/tanstack-start', '@hypdriv/core', '@hypdriv/cloudflare']
      : ['@hypdriv/tanstack-start', '@hypdriv/core'],
  install: (platform) =>
    platform === 'cloudflare'
      ? { devDependencies: ['@cloudflare/vite-plugin', 'wrangler', '@cloudflare/workers-types'] }
      : { dependencies: ['nitro'] },
  register(ctx) {
    registerInConfig(
      ctx,
      [
        ...(ctx.platform === 'cloudflare' ? [cloudflarePlugin('ssr')] : []),
        {
          element: 'hypdriv()',
          importLine: "import { hypdriv } from '@hypdriv/tanstack-start/vite';",
          from: '@hypdriv/tanstack-start/vite',
        },
        ...(ctx.platform !== 'cloudflare'
          ? [
              {
                element: 'nitro()',
                importLine: "import { nitro } from 'nitro/vite';",
                from: 'nitro/vite',
                before: /hypdriv\s*\(/,
              },
            ]
          : []),
      ],
      {
        file: /vite\.config\./,
        property: 'plugins',
        fallback: { path: 'vite.config.ts', content: '' },
      },
    );
    const vite = ctx.items.find((i) => /vite\.config\./.test(i.path) && i.action !== 'manual');
    const viteFile = ctx.project.framework.configFile;
    if (vite && viteFile) {
      const source = vite.content ?? ctx.read(viteFile);
      const r = wrapCallArgument(source, {
        callee: 'tanstackStart',
        wrapper: 'withHypDriv',
        importLine: "import { withHypDriv } from '@hypdriv/tanstack-start/vite';",
        importFrom: '@hypdriv/tanstack-start/vite',
      });
      if (r.changed) {
        vite.reason = vite.action === 'modify' ? `${vite.reason}; ${r.reason}` : r.reason;
        vite.action = 'modify';
        vite.content = r.content;
      } else if (!/already wrapped/.test(r.reason))
        ctx.notes.push(
          `vite.config: ${r.reason}; pass Start's options through withHypDriv() so prerendering stays outside the pipeline.`,
        );
    }
    planNewFile(
      ctx,
      'src/start.ts',
      "import { hypdrivRequestMiddleware } from '@hypdriv/tanstack-start';\nimport { createStart } from '@tanstack/react-start';\n\n// Hypdriv first (it wraps SSR documents, server routes, server functions, 404s), then Start's CSRF protection.\nconst requestMiddleware = hypdrivRequestMiddleware();\n\nexport const startInstance = createStart(() => ({ requestMiddleware }));\n",
      {
        uses: /hypdriv/i,
        reason: "global request middleware (Hypdriv, then Start's CSRF)",
        existing: 'src/start.ts exists; put hypdrivRequestMiddleware() first in requestMiddleware',
      },
    );
    ctx.notes.push(
      "For Start's own tags to carry the request nonce, pass `ssr: hypdrivSsr()` to createRouter() in src/router.tsx (import { hypdrivSsr } from '@hypdriv/tanstack-start'); without it the pipeline injects the nonce while streaming.",
    );
  },
  platform(ctx) {
    if (ctx.platform !== 'cloudflare') return;
    const configured = ctx.project.wrangler.config?.main ?? null;
    const main = configured ?? 'src/worker.ts';
    planWorkerEntry(
      ctx,
      main,
      `/// <reference types="@hypdriv/vite/virtual" />\nimport config from 'virtual:hypdriv/config';\nimport { createStartWorker } from '@hypdriv/tanstack-start/cloudflare';\n\n${DO_EXPORTS}\n\nexport default createStartWorker({ config, manifest: () => import('virtual:hypdriv/manifest') });\n`,
      /createStartWorker|createWorker/,
    );
    // Prerendered pages through the Worker (served from the assets binding as built) get the request stages.
    const assets = { binding: 'ASSETS', run_worker_first: ['/*', '!/assets/*'] };
    planHostWrangler(ctx, {
      main: configured ? null : main,
      durableObjects: true,
      assets: JSON.stringify(assets),
      template: () =>
        wranglerJson({
          $schema: 'node_modules/wrangler/config-schema.json',
          name: ctx.name,
          main,
          compatibility_date: defaultCompatibilityDate(ctx.now),
          compatibility_flags: ['nodejs_compat'],
          assets,
          observability: { enabled: true },
          durable_objects: { bindings: HYPDRIV_DO },
          migrations: HYPDRIV_MIGRATION,
        }),
    });
  },
  scripts: (platform) => ({
    'hypdriv:doctor': 'hypdriv doctor',
    ...(platform === 'node' ? { start: 'node .output/server/index.mjs' } : {}),
    'hypdriv:audit': `hypdriv audit all --url http://localhost:${platform === 'cloudflare' ? '4173' : '3000'}`,
  }),
};

export const SVELTEKIT_SPEC: HostSpec = {
  framework: 'sveltekit',
  packages: () => ['@hypdriv/sveltekit', '@hypdriv/core'],
  install: (platform) => ({
    devDependencies: [
      platform === 'cloudflare'
        ? '@sveltejs/adapter-cloudflare'
        : platform === 'vercel'
          ? '@sveltejs/adapter-vercel'
          : '@sveltejs/adapter-node',
      ...(platform === 'cloudflare' ? ['wrangler'] : []),
    ],
  }),
  register(ctx) {
    const viteFile =
      ctx.project.framework.configFile && /vite\.config\./.test(ctx.project.framework.configFile)
        ? rel(ctx.project.root, ctx.project.framework.configFile)
        : 'vite.config.ts';
    planFileEdit(
      ctx,
      viteFile,
      (source) =>
        wrapPropertyValue(source, {
          property: 'adapter',
          within: 'sveltekit',
          wrapper: 'hypdriv',
          importLine: "import { hypdriv } from '@hypdriv/sveltekit';",
          importFrom: '@hypdriv/sveltekit',
        }),
      {
        done: /@hypdriv\/sveltekit/,
        hint: "import { hypdriv } from '@hypdriv/sveltekit';\nplugins: [sveltekit({ adapter: hypdriv(adapter()) })]",
      },
    );
    planNewFile(
      ctx,
      'src/hooks.server.ts',
      "import { hypdriv } from '@hypdriv/sveltekit/hooks';\n\n// Hypdriv owns the full response (security headers, CSP, rate limiting, bot shield, `/_hypdriv/*`). With hooks of\n// your own: export const handle = sequence(hypdriv(), yourHandle) (import { sequence } from '@sveltejs/kit/hooks').\nexport const handle = hypdriv();\n",
      {
        uses: /@hypdriv\/sveltekit\/hooks/,
        reason: 'the Hypdriv handle hook',
        existing:
          'src/hooks.server.ts exists; export const handle = sequence(hypdriv(), …) with hypdriv() first',
      },
    );
  },
  platform(ctx) {
    if (ctx.platform === 'cloudflare') {
      const assets = {
        binding: 'ASSETS',
        directory: '.svelte-kit/cloudflare',
        run_worker_first: ['/*', '!/_app/immutable/*'],
      };
      planHostWrangler(ctx, {
        main: ctx.project.wrangler.config?.main ? null : '.svelte-kit/cloudflare/_worker.js',
        durableObjects: true,
        assets: JSON.stringify(assets),
        template: () =>
          wranglerJson({
            $schema: 'node_modules/wrangler/config-schema.json',
            name: ctx.name,
            main: '.svelte-kit/cloudflare/_worker.js',
            compatibility_date: defaultCompatibilityDate(ctx.now),
            compatibility_flags: ['nodejs_compat'],
            assets,
            observability: { enabled: true },
            durable_objects: { bindings: HYPDRIV_DO },
            migrations: HYPDRIV_MIGRATION,
          }),
      });
    } else if (ctx.platform === 'node')
      planNewFile(
        ctx,
        'server.js',
        "// adapter-node's build behind the Hypdriv pipeline (static files and prerendered pages included).\nimport { serve } from '@hypdriv/sveltekit/node';\n\nawait serve({ dir: 'build' });\n",
        { uses: /@hypdriv\/sveltekit\/node/, reason: "Node server around adapter-node's handler" },
      );
  },
  scripts: (platform) => ({
    'hypdriv:doctor': 'hypdriv doctor',
    ...(platform === 'node' ? { start: 'node server.js' } : {}),
    'hypdriv:audit': `hypdriv audit all --url http://localhost:${platform === 'cloudflare' ? '8787' : '3000'}`,
  }),
};

export const NUXT_SPEC: HostSpec = {
  framework: 'nuxt',
  packages: () => ['@hypdriv/nuxt', '@hypdriv/core'],
  install: (platform) => (platform === 'cloudflare' ? { devDependencies: ['wrangler'] } : {}),
  register(ctx) {
    registerInConfig(
      ctx,
      [
        {
          element: "'@hypdriv/nuxt'",
          importLine: '',
          from: '',
          position: 'last',
          present: /['"]@hypdriv\/nuxt['"]/,
        },
      ],
      {
        file: /nuxt\.config\./,
        property: 'modules',
        fallback: {
          path: 'nuxt.config.ts',
          content: "export default defineNuxtConfig({\n  modules: ['@hypdriv/nuxt'],\n});\n",
        },
      },
    );
    if (ctx.platform === 'cloudflare') {
      const source = ctx.project.framework.configFile ? ctx.read(ctx.project.framework.configFile) : '';
      if (!/cloudflare-module/.test(source))
        ctx.notes.push(
          "Build Nuxt for Workers with Nitro's `cloudflare-module` preset and `cloudflare: { deployConfig: true }` (nitro in nuxt.config): Hypdriv's module then puts its Worker shell around Nitro.",
        );
    }
  },
  platform(ctx) {
    if (ctx.platform !== 'cloudflare') return;
    planHostWrangler(ctx, {
      main: null,
      durableObjects: true,
      assets: JSON.stringify({ html_handling: 'drop-trailing-slash', run_worker_first: ['/*', '!/_nuxt/*'] }),
      template: () =>
        wranglerJson({
          $schema: 'node_modules/wrangler/config-schema.json',
          name: ctx.name,
          compatibility_date: defaultCompatibilityDate(ctx.now),
          compatibility_flags: ['nodejs_compat'],
          assets: { html_handling: 'drop-trailing-slash', run_worker_first: ['/*', '!/_nuxt/*'] },
          observability: { enabled: true },
          durable_objects: { bindings: HYPDRIV_DO },
          migrations: HYPDRIV_MIGRATION,
        }),
    });
  },
  scripts: (platform) => ({
    'hypdriv:doctor': 'hypdriv doctor',
    ...(platform === 'node' ? { start: 'node .output/server/index.mjs' } : {}),
    'hypdriv:audit': `hypdriv audit all --url http://localhost:${platform === 'cloudflare' ? '8787' : '3000'}`,
  }),
};

export const VINEXT_SPEC: HostSpec = {
  framework: 'vinext',
  packages: (platform) =>
    platform === 'cloudflare'
      ? ['@hypdriv/vinext', '@hypdriv/core', '@hypdriv/cloudflare']
      : ['@hypdriv/vinext', '@hypdriv/core'],
  install: (platform) =>
    platform === 'cloudflare'
      ? { devDependencies: ['@cloudflare/vite-plugin', 'wrangler', '@cloudflare/workers-types'] }
      : platform === 'vercel'
        ? { dependencies: ['nitro'] }
        : {},
  register(ctx) {
    registerInConfig(
      ctx,
      [
        // hypdriv() goes last, the platform plugin right before it (after vinext()).
        {
          element: 'hypdriv()',
          importLine: "import { hypdriv } from '@hypdriv/vinext';",
          from: '@hypdriv/vinext',
        },
        ...(ctx.platform === 'cloudflare'
          ? [{ ...cloudflarePlugin('rsc', ", childEnvironments: ['ssr']"), before: /hypdriv\s*\(/ }]
          : []),
        ...(ctx.platform === 'vercel'
          ? [
              {
                element: "nitro({ preset: 'vercel' })",
                importLine: "import { nitro } from 'nitro/vite';",
                from: 'nitro/vite',
                before: /hypdriv\s*\(/,
              },
            ]
          : []),
      ],
      { file: /vite\.config\./, property: 'plugins', fallback: { path: 'vite.config.ts', content: '' } },
    );
  },
  platform(ctx) {
    if (ctx.platform !== 'cloudflare') return;
    const configured = ctx.project.wrangler.config?.main ?? null;
    const main = configured ?? 'worker/index.ts';
    planWorkerEntry(
      ctx,
      main,
      `/// <reference types="@hypdriv/vinext/virtual" />\nimport config from 'virtual:hypdriv/config';\nimport manifest from 'virtual:hypdriv/manifest';\nimport { createVinextWorker } from '@hypdriv/vinext/worker';\nimport handler from 'vinext/server/fetch-handler';\n\n${DO_EXPORTS}\nexport * from 'vinext/server/fetch-handler';\n\nexport default createVinextWorker({ config, manifest, app: handler });\n`,
      /createVinextWorker|createWorker/,
    );
    const assets = {
      binding: 'ASSETS',
      html_handling: 'none',
      not_found_handling: 'none',
      run_worker_first: ['/*', '!/_next/static/*'],
    };
    planHostWrangler(ctx, {
      main: configured ? null : main,
      durableObjects: true,
      assets: JSON.stringify(assets),
      template: () =>
        wranglerJson({
          $schema: 'node_modules/wrangler/config-schema.json',
          name: ctx.name,
          main,
          compatibility_date: defaultCompatibilityDate(ctx.now),
          compatibility_flags: ['nodejs_compat'],
          assets,
          observability: { enabled: true },
          durable_objects: { bindings: HYPDRIV_DO },
          migrations: HYPDRIV_MIGRATION,
        }),
    });
  },
  scripts: (platform) => ({
    'hypdriv:doctor': 'hypdriv doctor',
    ...(platform === 'node' ? { start: 'vinext start' } : {}),
    'hypdriv:audit': `hypdriv audit all --url http://localhost:${platform === 'cloudflare' ? '4173' : '3000'}`,
  }),
};

/** `./hypdriv.config` as the entry file at `path` imports it. */
function configImportPath(path: string): string {
  const relative = posix.relative(posix.dirname(path.replace(/\\/g, '/')), 'hypdriv.config');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/** A new Hono entry for a project without one: the app behind Hypdriv, ready for the platform. */
export function honoEntryTemplate(platform: InitPlatform, path: string): string {
  return `import { useHypDriv } from '@hypdriv/hono';
import { Hono } from 'hono';
import config from '${configImportPath(path)}';
${platform === 'node' ? "import { serve } from '@hono/node-server';\n" : ''}${platform === 'cloudflare' ? `\n// Rate limiting, tag index and live channels use these Durable Objects (bound in wrangler.jsonc).\n${DO_EXPORTS}\n` : ''}
const app = new Hono();

// Hypdriv's request stages around everything the app answers (security headers, CSP nonce, rate limiting,
// bot shield, /_hypdriv/*). Register it first.
useHypDriv(app, { config });

app.get('/', (c) => c.text('Hello from Hono behind Hypdriv'));
${platform === 'node' ? '\nserve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });\n' : ''}
export default app;
`;
}

export const HONO_SPEC: HostSpec = {
  framework: 'hono',
  packages: (platform) =>
    platform === 'cloudflare'
      ? ['@hypdriv/hono', '@hypdriv/core', '@hypdriv/cloudflare']
      : ['@hypdriv/hono', '@hypdriv/core'],
  install: (platform) =>
    platform === 'cloudflare'
      ? { devDependencies: ['wrangler', '@cloudflare/workers-types'] }
      : platform === 'node'
        ? { dependencies: ['@hono/node-server'] }
        : {},
  register(ctx) {
    const entry = HONO_ENTRY_FILES.find((f) => existsSync(join(ctx.project.root, f)));
    const path = entry ?? 'src/index.ts';
    planFileEdit(
      ctx,
      path,
      (source) => {
        const declaration =
          /^([ \t]*)(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*new Hono\b[^\n]*;[ \t]*$/m.exec(
            source,
          );
        if (!declaration)
          return {
            changed: false,
            content: source,
            reason: 'could not find a one-line `const app = new Hono();`; register the middleware by hand',
          };
        const app = declaration[2] as string;
        const end = (declaration.index ?? 0) + declaration[0].length;
        let content = `${source.slice(0, end)}\n\n// Hypdriv's request stages around everything the app answers. Register it first.\nuseHypDriv(${app}, { config });${source.slice(end)}`;
        content = insertImport(content, "import { useHypDriv } from '@hypdriv/hono';", 'esm');
        content = insertImport(content, `import config from '${configImportPath(path)}';`, 'esm');
        if (ctx.platform === 'cloudflare' && !/HypDrivLimiter/.test(content))
          content = `${content.replace(/\s*$/, '')}\n\n// Rate limiting, tag index and live channels use these Durable Objects (bound in wrangler.jsonc).\n${DO_EXPORTS}\n`;
        return { changed: true, content, reason: 'register useHypDriv(app, { config })' };
      },
      {
        done: /@hypdriv\/hono/,
        fallback: honoEntryTemplate(ctx.platform, path),
        hint: `import { useHypDriv } from '@hypdriv/hono';\nimport config from '${configImportPath(path)}';\n\nconst app = new Hono();\nuseHypDriv(app, { config }); // first, so it wraps everything after it${ctx.platform === 'cloudflare' ? `\n${DO_EXPORTS}` : ''}\n\n// or around the whole app: export default wrapHono(app, { config });`,
      },
    );
  },
  platform(ctx) {
    if (ctx.platform === 'cloudflare') {
      const entry = HONO_ENTRY_FILES.find((f) => existsSync(join(ctx.project.root, f))) ?? 'src/index.ts';
      const configured = ctx.project.wrangler.config?.main ?? null;
      planHostWrangler(ctx, {
        main: configured ? null : entry,
        durableObjects: true,
        template: () =>
          wranglerJson({
            $schema: 'node_modules/wrangler/config-schema.json',
            name: ctx.name,
            main: configured ?? entry,
            compatibility_date: defaultCompatibilityDate(ctx.now),
            compatibility_flags: ['nodejs_compat'],
            observability: { enabled: true },
            durable_objects: { bindings: HYPDRIV_DO },
            migrations: HYPDRIV_MIGRATION,
          }),
      });
    } else if (ctx.platform === 'vercel')
      ctx.notes.push(
        "On Vercel a Hono app is a Function: `export default app` from src/index.ts (Vercel's zero-config Hono support). Hypdriv's middleware runs inside it; static files in `public/` are served by the CDN before it.",
      );
  },
  scripts: (platform) => ({
    'hypdriv:doctor': 'hypdriv doctor',
    'hypdriv:audit': `hypdriv audit all --url http://localhost:${platform === 'cloudflare' ? '8787' : '3000'}`,
  }),
};

/** Specs per framework; frameworks without one get the generic plan (config + package + manual registration). */
export const HOST_SPECS: Partial<Record<FrameworkName, HostSpec>> = {
  vite: VITE_SPEC,
  astro: ASTRO_SPEC,
  'react-router': REACT_ROUTER_SPEC,
  'tanstack-start': TANSTACK_START_SPEC,
  sveltekit: SVELTEKIT_SPEC,
  nuxt: NUXT_SPEC,
  vinext: VINEXT_SPEC,
  hono: HONO_SPEC,
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
      reason: 'Hypdriv configuration with commented defaults',
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
