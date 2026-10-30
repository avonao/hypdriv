import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedConfig } from '../context';
import type { ProjectInfo } from '../project';
import {
  defaultCompatibilityDate,
  devVarsExampleTemplate,
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
import { wrapNextConfig } from './next-config';
import { editPackageJson, ensureHeadersRule } from './package-json';
import { editWranglerJsonc } from './wrangler';

export type PlanAction = 'create' | 'modify' | 'skip' | 'manual';

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
}

export interface InitPlan {
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
}

export const BACKUP_SUFFIX = '.hypdriv.bak';

/** Computes every file action without touching the disk. */
export function buildInitPlan(project: ProjectInfo, loaded: LoadedConfig | null, options: InitOptions): InitPlan {
  const items: PlanItem[] = [];
  const notes: string[] = [];
  const nextSteps: string[] = [];
  const root = project.root;
  const name = workerName(project.packageJson?.name, 'next-app');
  const purser = options.purser || (project.purser.installed !== null && project.purser.tokensFile !== null);
  const crons = loaded ? Object.values(loaded.resolved.jobs.cron).map((j) => j.cron) : [];
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
    if (result.changed) items.push({ path, action: 'modify', reason: result.reason, content: result.content });
    else if (/\bwithHypDriv\s*\(/.test(source)) items.push({ path, action: 'skip', reason: result.reason });
    else
      items.push({
        path,
        action: 'manual',
        reason: result.reason,
        hint: `import { withHypDriv } from 'hypdriv/config';\nexport default withHypDriv(nextConfig);`,
      });
    if (project.nextConfig.output === 'export') notes.push("next.config sets `output: 'export'`; static export cannot run on OpenNext Cloudflare. Remove it before deploying.");
  }

  // 3. hypdriv.worker.ts
  if (project.hypdrivWorkerFile) items.push({ path: rel(root, project.hypdrivWorkerFile), action: 'skip', reason: 'exists' });
  else items.push({ path: 'hypdriv.worker.ts', action: 'create', reason: 'Worker entry wrapping .open-next/worker.js', content: workerTemplate() });

  // 4. wrangler config
  if (project.wrangler.configFile && project.wrangler.format === 'toml') {
    const cfg = project.wrangler.config;
    const needsMain = cfg?.main !== 'hypdriv.worker.ts';
    const needsObs = cfg?.observability?.enabled !== true;
    const missingCrons = crons.filter((c) => !(cfg?.triggers?.crons ?? []).includes(c));
    if (needsMain || needsObs || missingCrons.length) {
      items.push({
        path: rel(root, project.wrangler.configFile),
        action: 'manual',
        reason: 'wrangler.toml is not edited automatically; apply these changes',
        hint: wranglerTomlHint(crons),
      });
    } else items.push({ path: rel(root, project.wrangler.configFile), action: 'skip', reason: 'already configured' });
  } else if (project.wrangler.configFile) {
    const source = read(project.wrangler.configFile);
    const path = rel(root, project.wrangler.configFile);
    try {
      const edit = editWranglerJsonc(source, { main: 'hypdriv.worker.ts', observability: true, crons });
      if (edit.changes.length) items.push({ path, action: 'modify', reason: 'point main at the HypDriv worker', details: edit.changes, content: edit.content });
      else items.push({ path, action: 'skip', reason: 'already configured' });
    } catch (err) {
      items.push({ path, action: 'manual', reason: `could not edit (${(err as Error).message})`, hint: wranglerTomlHint(crons).replace(/^main = .*$/m, '"main": "hypdriv.worker.ts"') });
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
      content: wranglerTemplate({ name, purser, srcDir: project.srcDir, crons, compatibilityDate: defaultCompatibilityDate(options.now) }),
    });
    if (!project.opennext.installed) notes.push('`@opennextjs/cloudflare` is not installed. Run `npx @opennextjs/cloudflare@latest migrate` (or add it and an open-next.config.ts) before `pnpm preview`.');
  }

  // 5. proxy.ts
  const proxyPath = project.srcDir ? 'src/proxy.ts' : 'proxy.ts';
  if (options.noProxy) items.push({ path: proxyPath, action: 'skip', reason: '--no-proxy' });
  else if (project.proxyFile) {
    const source = read(project.proxyFile);
    if (/createProxy\s*\(/.test(source)) items.push({ path: rel(root, project.proxyFile), action: 'skip', reason: 'already uses createProxy()' });
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
      reason: 'middleware.ts is deprecated in Next.js 16; rename it to proxy.ts (npx @next/codemod@canary middleware-to-proxy .) and compose with createProxy()',
      hint: proxyCompositionHint(project.srcDir),
    });
  } else items.push({ path: proxyPath, action: 'create', reason: 'runs the HypDriv stages on next dev / next start', content: proxyTemplate({ srcDir: project.srcDir }) });

  // 6. public/_headers
  const headersFile = join(root, 'public', '_headers');
  const headers = ensureHeadersRule(existsSync(headersFile) ? read(headersFile) : null, HEADERS_RULE);
  if (!headers.changed) items.push({ path: 'public/_headers', action: 'skip', reason: 'immutable rule present' });
  else if (existsSync(headersFile)) items.push({ path: 'public/_headers', action: 'modify', reason: 'append the immutable /_next/static rule', content: headers.content });
  else items.push({ path: 'public/_headers', action: 'create', reason: 'immutable caching for /_next/static', content: headers.content });

  // 7. .dev.vars.example
  if (project.devVars.exampleFile) items.push({ path: '.dev.vars.example', action: 'skip', reason: 'exists' });
  else items.push({ path: '.dev.vars.example', action: 'create', reason: 'documents the secrets wrangler dev expects', content: devVarsExampleTemplate() });

  // 8. instrumentation.ts
  const instrumentationPath = project.srcDir ? 'src/instrumentation.ts' : 'instrumentation.ts';
  if (project.instrumentationFile) items.push({ path: rel(root, project.instrumentationFile), action: 'skip', reason: 'exists' });
  else items.push({ path: instrumentationPath, action: 'create', reason: 'error reporting hooks (register, onRequestError)', content: instrumentationTemplate({ srcDir: project.srcDir }) });

  // 9. package.json
  const pkgFile = join(root, 'package.json');
  if (existsSync(pkgFile)) {
    const source = read(pkgFile);
    try {
      const range = project.inHypDrivMonorepo ? 'workspace:*' : `^${options.cliVersion}`;
      const edit = editPackageJson(source, { scripts: scriptsTemplate(), dependency: { name: 'hypdriv', range } });
      if (edit.changes.length) {
        items.push({ path: 'package.json', action: 'modify', reason: 'scripts and dependency', details: edit.changes, content: edit.content });
        if (edit.changes.some((c) => c.startsWith('dependency'))) nextSteps.push(`Install the new dependency: ${installHint(project.packageManager)}`);
      } else items.push({ path: 'package.json', action: 'skip', reason: 'scripts and dependency present' });
    } catch (err) {
      items.push({ path: 'package.json', action: 'manual', reason: `could not parse (${(err as Error).message})`, hint: JSON.stringify(scriptsTemplate(), null, 2) });
    }
  } else items.push({ path: 'package.json', action: 'manual', reason: 'no package.json found', hint: JSON.stringify(scriptsTemplate(), null, 2) });

  // Notes and next steps.
  if (purser && !project.purser.installed) notes.push('Purser section scaffolded, but @avonao/purser is not installed yet: `pnpm add -D @avonao/purser` and create the tokens module (lib/tokens.ts).');
  if (purser && project.purser.installed && !project.purser.tokensFile) notes.push('Purser is installed but no tokens module was found; create lib/tokens.ts (or set purser.tokens) and import app/purser.css in your root layout.');
  if (project.typescript.major !== null && project.typescript.major >= 7 && purser) notes.push('TypeScript 7 detected: Purser needs TypeScript 6 at build time (pnpm add -D typescript@^6 or the @typescript/typescript6 alias).');
  if (project.sources.edgeRuntime.length) notes.push(`${project.sources.edgeRuntime.length} route file(s) export the Edge runtime; OpenNext Cloudflare does not support it (see \`hypdriv doctor\`).`);

  nextSteps.push('Build once so the HypDriv adapter writes .hypdriv/manifest.json: `next build` (or your build script).');
  nextSteps.push('Copy .dev.vars.example to .dev.vars for `wrangler dev`, and set production secrets: `wrangler secret put HYPDRIV_SESSION_SECRET`, `wrangler secret put HYPDRIV_INTERNAL_SECRET`.');
  nextSteps.push('Optional bindings unlock upgrades (KV tier, Durable Objects, Analytics Engine, Rate Limiting): docs/guides/cloudflare.md.');
  nextSteps.push('Render <HypDrivDevTools /> and <VitalsReporter /> from hypdriv/client in your root layout for the HUD and Web Vitals.');
  nextSteps.push('Verify: `hypdriv doctor`, then `hypdriv routes` after the build and `hypdriv audit all --url http://localhost:8787` against the preview.');

  return { items, notes, nextSteps, purser };
}

function installHint(pm: ProjectInfo['packageManager']): string {
  return pm === 'npm' ? 'npm install' : `${pm} install`;
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
    if (item.action === 'modify' && existsSync(file)) {
      const backup = `${file}${BACKUP_SUFFIX}`;
      copyFileSync(file, backup);
      backups.push(rel(root, backup));
    }
    writeText(file, item.content);
    written.push(item.path);
  }
  return { written, backups };
}
