import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedConfig } from '../context';
import type { ProjectInfo } from '../project';
import {
  defaultCompatibilityDate,
  devVarsExampleTemplate,
  envExampleTemplate,
  HEADERS_RULE,
  hypdrivConfigTemplate,
  instrumentationTemplate,
  proxyCompositionHint,
  proxyTemplate,
  scriptsTemplate,
  workerName,
  workerTemplate,
  wranglerTemplate,
  wranglerTomlHint,
} from '../templates';
import { rel, writeText } from '../util/fs';
import { upsertVercelCrons, type VercelCron } from '../vercel-config';
import { buildHostPlan } from './hosts';
import { wrapNextConfig } from './next-config';
import { editPackageJson, ensureHeadersRule } from './package-json';
import { addTsconfigExclude } from './tsconfig';
import { editWranglerJsonc } from './wrangler';

export type PlanAction = 'create' | 'modify' | 'skip' | 'manual';

/** Platforms `init` can target. */
export type InitPlatform = 'cloudflare' | 'vercel' | 'node';

export interface PlanItem {
  /** Project-relative path. */
  path: string;
  action: PlanAction;
  reason: string;
  /** Detailed changes (wrangler keys, scripts). */
  details?: string[];
  /** New file content for `create` / `modify`. */
  content?: string;
  /** Instructions for `manual` items or hints for skipped ones. */
  hint?: string;
  /** `false`: append-only edit, no `.hypdriv.bak` copy. */
  backup?: boolean;
}

export interface InitPlan {
  platform: InitPlatform;
  items: PlanItem[];
  /** Printed after the plan. */
  notes: string[];
  nextSteps: string[];
  purser: boolean;
}

export interface InitOptions {
  purser: boolean;
  noProxy: boolean;
  now: Date;
  cliVersion: string;
  /** Target platform; defaults to the detected one (`node`/`unknown` → `cloudflare`, HypDriv's reference target). */
  platform?: InitPlatform;
}

export const BACKUP_SUFFIX = '.hypdriv.bak';

/** The platform `init` writes for: explicit, else detected, with Cloudflare for projects without tooling. */
export function initPlatform(project: ProjectInfo, explicit?: InitPlatform): InitPlatform {
  if (explicit) return explicit;
  if (project.platform === 'vercel') return 'vercel';
  if (project.platform === 'node' && project.platformDetection.explicit) return 'node';
  return 'cloudflare';
}

/** Computes every file action without touching the disk. */
export function buildInitPlan(
  project: ProjectInfo,
  loaded: LoadedConfig | null,
  options: InitOptions,
): InitPlan {
  const platform = initPlatform(project, options.platform);
  // Vite hosts (ADR 0019) have their own plan: registration in the framework config, no Next.js files.
  if (project.framework.name !== 'next' && project.framework.name !== 'unknown')
    return buildHostPlan(project, loaded, { ...options, platform });
  const items: PlanItem[] = [];
  const notes: string[] = [];
  const nextSteps: string[] = [];
  const root = project.root;
  const name = workerName(project.packageJson?.name, 'next-app');
  const purser = options.purser || (project.purser.installed !== null && project.purser.tokensFile !== null);
  const cronJobs = loaded ? Object.values(loaded.resolved.jobs.cron) : [];
  const crons = cronJobs.map((j) => j.cron);
  const read = (file: string) => readFileSync(file, 'utf8');

  // 1. hypdriv.config.ts
  if (project.hypdrivConfigFile) {
    items.push({ path: rel(root, project.hypdrivConfigFile), action: 'skip', reason: 'exists' });
  } else {
    items.push({
      path: 'hypdriv.config.ts',
      action: 'create',
      reason: 'HypDriv configuration with commented defaults',
      content: hypdrivConfigTemplate({
        name,
        purser,
        srcDir: project.srcDir,
        platform,
        ...(project.purser.tokensFile ? { purserTokens: project.purser.tokensFile } : {}),
      }),
    });
  }

  // 2. next.config.*
  if (!project.nextConfig) {
    items.push({
      path: 'next.config.ts',
      action: 'create',
      reason: 'no next.config found; creating one wrapped in withHypDriv()',
      content: `import type { NextConfig } from 'next';\nimport { withHypDriv } from 'hypdriv/config';\n\nconst nextConfig: NextConfig = {};\n\nexport default withHypDriv(nextConfig);\n`,
    });
  } else {
    const source = read(project.nextConfig.file);
    const result = wrapNextConfig(source);
    const path = rel(root, project.nextConfig.file);
    if (result.changed)
      items.push({ path, action: 'modify', reason: result.reason, content: result.content });
    else if (/\bwithHypDriv\s*\(/.test(source)) items.push({ path, action: 'skip', reason: result.reason });
    else
      items.push({
        path,
        action: 'manual',
        reason: result.reason,
        hint: `import { withHypDriv } from 'hypdriv/config';\nexport default withHypDriv(nextConfig);`,
      });
    if (project.nextConfig.output === 'export')
      notes.push(
        "next.config sets `output: 'export'`; a static export has no server for HypDriv's stages. Remove it before deploying.",
      );
  }

  if (platform === 'cloudflare')
    planCloudflare(project, items, notes, { name, purser, crons, now: options.now, read });
  if (platform === 'vercel')
    planVercel(project, items, notes, {
      crons: cronJobs.map((j) => ({ path: j.path, schedule: j.cron })),
      read,
    });

  // proxy.ts
  const proxyPath = project.srcDir ? 'src/proxy.ts' : 'proxy.ts';
  if (options.noProxy) items.push({ path: proxyPath, action: 'skip', reason: '--no-proxy' });
  else if (project.proxyFile) {
    const source = read(project.proxyFile);
    if (/createProxy\s*\(/.test(source))
      items.push({
        path: rel(root, project.proxyFile),
        action: 'skip',
        reason: 'already uses createProxy()',
      });
    else
      items.push({
        path: rel(root, project.proxyFile),
        action: 'manual',
        reason: 'proxy.ts exists; compose it with createProxy()',
        hint: proxyCompositionHint(project.srcDir),
      });
  } else if (project.middlewareFile) {
    items.push({
      path: rel(root, project.middlewareFile),
      action: 'manual',
      reason:
        'middleware.ts is deprecated in Next.js 16; rename it to proxy.ts (npx @next/codemod@canary middleware-to-proxy .) and compose with createProxy()',
      hint: proxyCompositionHint(project.srcDir),
    });
  } else
    items.push({
      path: proxyPath,
      action: 'create',
      reason: 'runs the HypDriv stages on next dev / next start',
      content: proxyTemplate({ srcDir: project.srcDir }),
    });

  // Secrets template
  if (platform === 'cloudflare') {
    if (project.devVars.exampleFile) {
      items.push({ path: '.dev.vars.example', action: 'skip', reason: 'exists' });
      const names = ['HYPDRIV_SESSION_SECRET', 'HYPDRIV_INTERNAL_SECRET'].filter(
        (name) => !read(project.devVars.exampleFile as string).includes(name),
      );
      if (names.length)
        notes.push(
          `.dev.vars.example exists and does not list ${names.join(' and ')}; add ${names.map((n) => `${n}=`).join(' and ')} so \`wrangler dev\` and \`hypdriv audit\` find them.`,
        );
    } else
      items.push({
        path: '.dev.vars.example',
        action: 'create',
        reason: 'documents the secrets wrangler dev expects',
        content: devVarsExampleTemplate(),
      });
  } else if (existsSync(join(root, '.env.example')))
    items.push({ path: '.env.example', action: 'skip', reason: 'exists' });
  else
    items.push({
      path: '.env.example',
      action: 'create',
      reason: 'documents the secrets HypDriv reads',
      content: envExampleTemplate({ crons: platform === 'vercel' && crons.length > 0 }),
    });

  // .gitignore: local secrets, build output and the backups init itself writes must never be committed.
  const ignored = [join(root, '.gitignore'), join(project.repoRoot, '.gitignore')]
    .filter((file, i, all) => all.indexOf(file) === i && existsSync(file))
    .map((file) => read(file))
    .join('\n');
  const wantIgnore: Array<[string, RegExp, boolean]> = [
    ['.dev.vars', /^\s*\/?\.dev\.vars(\*|\.\*)?\s*$/m, platform === 'cloudflare'],
    ['.hypdriv/', /^\s*\/?\.hypdriv\/?\s*$/m, true],
    ['*.hypdriv.bak', /^\s*(\*\*\/)?\*\.(hypdriv\.)?bak\s*$/m, true],
  ];
  const missingIgnore = wantIgnore.filter(([, pattern, applies]) => applies && !pattern.test(ignored));
  if (missingIgnore.length) {
    const file = join(root, '.gitignore');
    const current = existsSync(file) ? read(file) : '';
    items.push({
      path: '.gitignore',
      action: existsSync(file) ? 'modify' : 'create',
      reason: 'local secrets, build output and init backups stay out of git',
      details: missingIgnore.map(([entry]) => `add ${entry}`),
      content: `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}# HypDriv\n${missingIgnore.map(([entry]) => entry).join('\n')}\n`,
      backup: false,
    });
  }

  // instrumentation.ts
  const instrumentationPath = project.srcDir ? 'src/instrumentation.ts' : 'instrumentation.ts';
  if (project.instrumentationFile)
    items.push({ path: rel(root, project.instrumentationFile), action: 'skip', reason: 'exists' });
  else
    items.push({
      path: instrumentationPath,
      action: 'create',
      reason: 'error reporting hooks (register, onRequestError)',
      content: instrumentationTemplate({ srcDir: project.srcDir }),
    });

  // package.json
  const pkgFile = join(root, 'package.json');
  const scripts = scriptsTemplate(platform);
  if (existsSync(pkgFile)) {
    const source = read(pkgFile);
    try {
      const range = project.inHypDrivMonorepo ? 'workspace:*' : `^${options.cliVersion}`;
      const edit = editPackageJson(source, { scripts, dependency: { name: 'hypdriv', range } });
      if (edit.changes.length) {
        items.push({
          path: 'package.json',
          action: 'modify',
          reason: 'scripts and dependency',
          details: edit.changes,
          content: edit.content,
        });
        if (edit.changes.some((c) => c.startsWith('dependency')))
          nextSteps.push(
            `Install the new dependency: ${project.packageManager === 'npm' ? 'npm install' : `${project.packageManager} install`}`,
          );
      } else items.push({ path: 'package.json', action: 'skip', reason: 'scripts and dependency present' });
    } catch (err) {
      items.push({
        path: 'package.json',
        action: 'manual',
        reason: `could not parse (${(err as Error).message})`,
        hint: JSON.stringify(scripts, null, 2),
      });
    }
  } else
    items.push({
      path: 'package.json',
      action: 'manual',
      reason: 'no package.json found',
      hint: JSON.stringify(scripts, null, 2),
    });

  // Notes and next steps.
  if (purser && !project.purser.installed)
    notes.push(
      'Purser section scaffolded, but @avonao/purser is not installed yet: `pnpm add -D @avonao/purser` and create the tokens module (lib/tokens.ts).',
    );
  if (purser && project.purser.installed && !project.purser.tokensFile)
    notes.push(
      'Purser is installed but no tokens module was found; create lib/tokens.ts (or set purser.tokens) and import app/purser.css in your root layout.',
    );
  if (project.typescript.major !== null && project.typescript.major >= 7 && purser)
    notes.push(
      'TypeScript 7 detected: Purser needs TypeScript 6 at build time (pnpm add -D typescript@^6 or the @typescript/typescript6 alias).',
    );
  if (project.sources.edgeRuntime.length)
    notes.push(
      `${project.sources.edgeRuntime.length} route file(s) export the Edge runtime; HypDriv targets the Node.js runtime (see \`hypdriv doctor\`).`,
    );

  nextSteps.push(
    'Build once so the HypDriv adapter writes .hypdriv/manifest.json: `next build` (or your build script).',
  );
  if (platform === 'cloudflare') {
    nextSteps.push(
      'Copy .dev.vars.example to .dev.vars for `wrangler dev`, and set production secrets: `wrangler secret put HYPDRIV_SESSION_SECRET`, `wrangler secret put HYPDRIV_INTERNAL_SECRET`.',
    );
    nextSteps.push(
      'Optional bindings unlock upgrades (KV tier, Durable Objects, Analytics Engine, Rate Limiting): docs/guides/cloudflare.md.',
    );
  } else if (platform === 'vercel') {
    nextSteps.push(
      `Set the secrets on Vercel: \`vercel env add HYPDRIV_SESSION_SECRET\`${crons.length ? ', `vercel env add CRON_SECRET`' : ''}; pull them locally with \`vercel env pull .env.local\`.`,
    );
    nextSteps.push(
      'Measure the function bundles: `vercel build` then `hypdriv analyze` (250 MB limit per function).',
    );
  } else nextSteps.push('Copy .env.example to .env.local and set real secrets in your hosting environment.');
  nextSteps.push(
    'Render <HypDrivDevTools /> and <VitalsReporter /> from hypdriv/client in your root layout for the HUD and Web Vitals.',
  );
  nextSteps.push(
    platform === 'cloudflare'
      ? 'Verify: `hypdriv doctor`, then `hypdriv routes` after the build and `hypdriv audit all --url http://localhost:8787` against the preview.'
      : 'Verify: `hypdriv doctor`, then `hypdriv routes` after the build and `hypdriv audit all --url http://localhost:3000` against `next start`.',
  );

  return { platform, items, notes, nextSteps, purser };
}

function planCloudflare(
  project: ProjectInfo,
  items: PlanItem[],
  notes: string[],
  o: { name: string; purser: boolean; crons: string[]; now: Date; read: (file: string) => string },
): void {
  const root = project.root;
  // hypdriv.worker.ts
  if (project.hypdrivWorkerFile)
    items.push({ path: rel(root, project.hypdrivWorkerFile), action: 'skip', reason: 'exists' });
  else
    items.push({
      path: 'hypdriv.worker.ts',
      action: 'create',
      reason: 'Worker entry wrapping .open-next/worker.js',
      content: workerTemplate(),
    });

  // tsconfig.json exclude
  const tsconfig = join(root, 'tsconfig.json');
  if (existsSync(tsconfig)) {
    try {
      const edit = addTsconfigExclude(o.read(tsconfig), 'hypdriv.worker.ts');
      if (edit.changed)
        items.push({
          path: 'tsconfig.json',
          action: 'modify',
          reason: 'exclude hypdriv.worker.ts (it imports .open-next/ build output)',
          content: edit.content,
        });
      else
        items.push({ path: 'tsconfig.json', action: 'skip', reason: 'hypdriv.worker.ts already excluded' });
    } catch (err) {
      items.push({
        path: 'tsconfig.json',
        action: 'manual',
        reason: `could not parse (${(err as Error).message})`,
        hint: '"exclude": ["node_modules", ".open-next", "hypdriv.worker.ts"]',
      });
    }
  }

  // wrangler config
  if (project.wrangler.configFile && project.wrangler.format === 'toml') {
    const cfg = project.wrangler.config;
    const needsMain = cfg?.main !== 'hypdriv.worker.ts';
    const needsObs = cfg?.observability?.enabled !== true;
    const missingCrons = o.crons.filter((c) => !(cfg?.triggers?.crons ?? []).includes(c));
    if (needsMain || needsObs || missingCrons.length) {
      items.push({
        path: rel(root, project.wrangler.configFile),
        action: 'manual',
        reason: 'wrangler.toml is not edited automatically; apply these changes',
        hint: wranglerTomlHint(o.crons),
      });
    } else
      items.push({
        path: rel(root, project.wrangler.configFile),
        action: 'skip',
        reason: 'already configured',
      });
  } else if (project.wrangler.configFile) {
    const path = rel(root, project.wrangler.configFile);
    try {
      const edit = editWranglerJsonc(o.read(project.wrangler.configFile), {
        main: 'hypdriv.worker.ts',
        observability: true,
        crons: o.crons,
      });
      if (edit.changes.length)
        items.push({
          path,
          action: 'modify',
          reason: 'point main at the HypDriv worker',
          details: edit.changes,
          content: edit.content,
        });
      else items.push({ path, action: 'skip', reason: 'already configured' });
    } catch (err) {
      items.push({
        path,
        action: 'manual',
        reason: `could not edit (${(err as Error).message})`,
        hint: '"main": "hypdriv.worker.ts"',
      });
    }
  } else if (project.cloudflareConfigFile) {
    items.push({
      path: rel(root, project.cloudflareConfigFile),
      action: 'manual',
      reason: 'cloudflare.config.ts (cf CLI format) detected; set the entry to hypdriv.worker.ts there',
      hint: 'main: "hypdriv.worker.ts"',
    });
  } else {
    items.push({
      path: 'wrangler.jsonc',
      action: 'create',
      reason: 'no wrangler config found; creating one for OpenNext Cloudflare',
      content: wranglerTemplate({
        name: o.name,
        purser: o.purser,
        srcDir: project.srcDir,
        crons: o.crons,
        compatibilityDate: defaultCompatibilityDate(o.now),
      }),
    });
    if (!project.opennext.installed)
      notes.push(
        '`@opennextjs/cloudflare` is not installed. Run `npx @opennextjs/cloudflare@latest migrate` (or add it and an open-next.config.ts) before `pnpm preview`.',
      );
  }

  // public/_headers
  const headersFile = join(root, 'public', '_headers');
  const headers = ensureHeadersRule(existsSync(headersFile) ? o.read(headersFile) : null, HEADERS_RULE);
  if (!headers.changed)
    items.push({ path: 'public/_headers', action: 'skip', reason: 'immutable rule present' });
  else if (existsSync(headersFile))
    items.push({
      path: 'public/_headers',
      action: 'modify',
      reason: 'append the immutable /_next/static rule',
      content: headers.content,
    });
  else
    items.push({
      path: 'public/_headers',
      action: 'create',
      reason: 'immutable caching for /_next/static',
      content: headers.content,
    });
}

export function planVercel(
  project: ProjectInfo,
  items: PlanItem[],
  notes: string[],
  o: { crons: VercelCron[]; read: (file: string) => string },
): void {
  const root = project.root;
  const v = project.vercel;
  if (!o.crons.length) {
    items.push({
      path: v.configFile ? rel(root, v.configFile) : 'vercel.json',
      action: 'skip',
      reason: 'no jobs.cron to schedule',
    });
  } else if (v.format === 'ts' && v.configFile) {
    const missing = o.crons.filter(
      (c) => !(v.config?.crons ?? []).some((d) => d.path === c.path && d.schedule === c.schedule),
    );
    if (missing.length) {
      items.push({
        path: rel(root, v.configFile),
        action: 'manual',
        reason: 'vercel.ts is code; add the crons yourself',
        hint: `crons: [\n${missing.map((c) => `  { path: '${c.path}', schedule: '${c.schedule}' },`).join('\n')}\n]`,
      });
    } else items.push({ path: rel(root, v.configFile), action: 'skip', reason: 'crons present' });
  } else {
    const file = v.configFile ?? join(root, 'vercel.json');
    try {
      const existing = existsSync(file) ? o.read(file) : null;
      const edit = upsertVercelCrons(existing, o.crons);
      if (!edit.changes.length)
        items.push({ path: 'vercel.json', action: 'skip', reason: 'crons in sync with jobs.cron' });
      else
        items.push({
          path: 'vercel.json',
          action: existing === null ? 'create' : 'modify',
          reason: 'schedule jobs.cron on Vercel Cron',
          details: edit.changes,
          content: edit.content,
        });
    } catch (err) {
      items.push({
        path: 'vercel.json',
        action: 'manual',
        reason: `could not edit (${(err as Error).message})`,
        hint: JSON.stringify({ crons: o.crons }, null, 2),
      });
    }
  }
  if (o.crons.length)
    notes.push(
      'Vercel Cron calls each job path with GET and `Authorization: Bearer $CRON_SECRET`; export GET from the job routes and set CRON_SECRET.',
    );
  if (project.wrangler.configFile || project.hypdrivWorkerFile)
    notes.push(
      'Cloudflare files (wrangler config / hypdriv.worker.ts) exist; they are left untouched and unused on Vercel.',
    );
}

export interface ApplyResult {
  written: string[];
  backups: string[];
}

/** Writes every `create`/`modify` item, backing up modified files as `*.hypdriv.bak` first. */
export function applyInitPlan(plan: InitPlan, root: string): ApplyResult {
  const written: string[] = [];
  const backups: string[] = [];
  for (const item of plan.items) {
    if ((item.action !== 'create' && item.action !== 'modify') || item.content === undefined) continue;
    const file = join(root, item.path);
    if (item.action === 'modify' && item.backup !== false && existsSync(file)) {
      const backup = `${file}${BACKUP_SUFFIX}`;
      copyFileSync(file, backup);
      backups.push(rel(root, backup));
    }
    writeText(file, item.content);
    written.push(item.path);
  }
  return { written, backups };
}
