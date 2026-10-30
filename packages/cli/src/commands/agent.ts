import type { ResolvedConfig } from '@hypdriv/core';
import { createContext, type LoadedConfig } from '../context';
import { cliInvocation, PLATFORM_RUNTIME_PACKAGE, type ProjectInfo, runScriptCommand } from '../project';
import { rel } from '../util/fs';
import { cliVersion } from '../version';
import { defineCommand } from './types';

const DOCS = 'https://github.com/avonao/hypdriv/blob/main/docs';

export interface AgentBriefing {
  project: {
    name: string;
    root: string;
    platform: ProjectInfo['platform'];
    platformSignals: ProjectInfo['platformDetection']['signals'];
    packageManager: string;
    versions: Record<string, string | null>;
    router: ProjectInfo['router'];
  };
  files: Record<string, string | null>;
  config: { file: string | null; error: string | null; summary: string[] };
  build: { manifest: boolean; buildId: string | null; routes: number; warnings: string[] };
  commands: Array<{ command: string; purpose: string }>;
  issues: string[];
  docs: Array<{ title: string; url: string }>;
}

function configSummary(r: ResolvedConfig): string[] {
  const out: string[] = [];
  out.push(`site: ${r.site.name}${r.site.origin ? ` (${r.site.origin})` : ''}`);
  if (r.security.csp)
    out.push(
      `CSP: mode ${r.security.csp.mode}${r.security.csp.reportOnly ? ' (report-only)' : ''}; allow-lists: ${
        Object.entries(r.security.csp.allow)
          .filter(([, v]) => v.length)
          .map(([k, v]) => `${k}=${v.join(' ')}`)
          .join('; ') || 'none'
      }`,
    );
  else out.push('CSP: off');
  out.push(
    `security headers: ${r.security.headers ? 'A+ preset' : 'off'} · shield: ${r.security.shield ? 'on' : 'off'} · bots: ${r.security.bots ? 'on' : 'off'}`,
  );
  if (r.security.rateLimit.length)
    out.push(
      `rate limits: ${r.security.rateLimit.map((p) => `${p.id} ${p.limit}/${p.windowSeconds}s on ${String(p.match)}`).join('; ')}`,
    );
  if (r.cache.edge)
    out.push(
      `edge cache: ${r.cache.edge.policies.length} explicit polic${r.cache.edge.policies.length === 1 ? 'y' : 'ies'} (${r.cache.edge.policies.map((p) => p.id).join(', ') || '—'}), inference ${r.cache.edge.infer ? 'on' : 'off'}, store ${r.cache.edge.store}`,
    );
  const flags = Object.keys(r.flags.definitions);
  if (flags.length) out.push(`flags (${r.flags.provider}): ${flags.join(', ')}`);
  const crons = Object.entries(r.jobs.cron);
  if (crons.length)
    out.push(`cron jobs: ${crons.map(([n, j]) => `${n} "${j.cron}" → ${j.path}`).join('; ')}`);
  if (Object.keys(r.jobs.queues).length) out.push(`queues: ${Object.keys(r.jobs.queues).join(', ')}`);
  if (r.purser)
    out.push(
      `Purser: ${String(r.purser.enabled)} (out ${r.purser.out}, prefix ${r.purser.prefix}${r.purser.theme ? `, theme axes ${Object.keys(r.purser.theme.axes).join(', ')}` : ''})`,
    );
  out.push(
    `observability: tracing ${r.observe.tracing?.exporter ?? 'off'}, vitals ${r.observe.vitals?.sink ?? 'off'}`,
  );
  const budgets = Object.entries(r.budgets.routes);
  if (budgets.length || r.budgets.worker.gzip || r.budgets.worker.raw)
    out.push(
      `budgets (failOn ${r.budgets.failOn}): ${budgets.map(([p, b]) => `${p} js ${b.js ?? '—'}`).join('; ')}${r.budgets.worker.gzip ? `; worker gzip ${r.budgets.worker.gzip}` : ''}`,
    );
  return out;
}

/** Builds the agent briefing (pure; testable). */
export function buildBriefing(project: ProjectInfo, loaded: LoadedConfig): AgentBriefing {
  const cli = cliInvocation(project.packageManager);
  const manifest = project.manifest?.data ?? null;
  const p = project.platform;
  const commands: AgentBriefing['commands'] = [
    { command: `${cli} doctor --json`, purpose: 'every check with id, status, message and fix; start here' },
    {
      command: `${cli} doctor --fix`,
      purpose: 'apply safe fixes (crons, observability, _headers, scripts, env examples)',
    },
    {
      command: runScriptCommand(project.packageManager, 'build'),
      purpose: 'next build → .hypdriv/manifest.json (routes, CSP hashes, hints, weights)',
    },
    { command: `${cli} routes`, purpose: 'classification, cache policy and CSP mode per route' },
  ];
  if (p === 'vercel')
    commands.push({
      command: `vercel build && ${cli} analyze`,
      purpose: 'function bundle sizes vs the 250 MB limit, per-route JS/CSS, budgets',
    });
  else
    commands.push({
      command: `opennextjs-cloudflare build && ${cli} analyze`,
      purpose: 'Worker weight by module/package, per-route JS/CSS, budgets',
    });
  const previewUrl = p === 'cloudflare' ? 'http://localhost:8787' : 'http://localhost:3000';
  commands.push({
    command: `${cli} audit all --url ${previewUrl}`,
    purpose: `headers grade, CSP validity, cache statuses against ${p === 'cloudflare' ? '`opennextjs-cloudflare preview`' : '`next start`'}`,
  });
  commands.push({ command: `${cli} budget --ci`, purpose: 'fail CI on exceeded budgets' });
  commands.push({
    command: `${cli} csp suggest --reports <file.ndjson>`,
    purpose: 'turn collected CSP violations into allow-list proposals',
  });
  commands.push({ command: `${cli} deps`, purpose: 'dependency freshness; `--update safe` for patch/minor' });
  const issues: string[] = [];
  if (!project.nextConfig?.wrapped)
    issues.push('next.config is not wrapped in withHypDriv() → run `hypdriv init`.');
  if (!project.hypdrivConfigFile) issues.push('No hypdriv.config.ts → run `hypdriv init`.');
  if (p === 'cloudflare' && !project.hypdrivWorkerFile)
    issues.push('No hypdriv.worker.ts (Worker entry) → run `hypdriv init`.');
  if (
    p === 'cloudflare' &&
    project.wrangler.config?.main &&
    !/hypdriv\.worker/.test(project.wrangler.config.main)
  )
    issues.push(`wrangler main is ${project.wrangler.config.main}, not hypdriv.worker.ts.`);
  if (project.middlewareFile)
    issues.push(`${rel(project.root, project.middlewareFile)} is deprecated; rename to proxy.ts.`);
  if (project.sources.edgeRuntime.length)
    issues.push(
      `${project.sources.edgeRuntime.length} Edge runtime segment(s); HypDriv targets the Node.js runtime.`,
    );
  if (p === 'cloudflare' && project.sources.nodeApis.some((f) => f.severity === 'error'))
    issues.push(
      'Node APIs unsupported on workerd are imported (see `hypdriv doctor`, check compat.node-apis).',
    );
  if (!manifest) issues.push('No build manifest yet → run the build.');
  if (loaded.error) issues.push(`hypdriv.config failed to load: ${loaded.error}`);
  const docs = [
    { title: 'Getting started', url: `${DOCS}/guides/getting-started.md` },
    { title: 'Configuration reference', url: `${DOCS}/guides/configuration.md` },
    { title: 'CLI', url: `${DOCS}/guides/cli.md` },
    p === 'vercel'
      ? { title: 'Vercel', url: `${DOCS}/guides/vercel.md` }
      : { title: 'Cloudflare bindings', url: `${DOCS}/guides/cloudflare.md` },
    { title: 'Caching', url: `${DOCS}/guides/caching.md` },
    { title: 'Security', url: `${DOCS}/guides/security.md` },
    { title: 'Purser CSS', url: `${DOCS}/guides/purser.md` },
    { title: 'Agent skill', url: 'https://github.com/avonao/hypdriv/blob/main/skills/hypdriv/SKILL.md' },
  ];
  const f = (file: string | null) => (file ? rel(project.root, file) : null);
  return {
    project: {
      name: project.name,
      root: project.root,
      platform: p,
      platformSignals: project.platformDetection.signals,
      packageManager: project.packageManager,
      versions: {
        node: project.node,
        next: project.next.installed,
        react: project.react.installed,
        typescript: project.typescript.installed,
        hypdriv: project.hypdriv.installed,
        cli: cliVersion(),
        ...(p === 'cloudflare'
          ? { '@opennextjs/cloudflare': project.opennext.installed, wrangler: project.wrangler.installed }
          : {}),
        ...(p === 'vercel'
          ? {
              vercel: project.vercel.cli,
              '@hypdriv/vercel': project.hypdriv.packages['@hypdriv/vercel'] ?? null,
            }
          : {}),
        purser: project.purser.installed,
      },
      router: project.router,
    },
    files: {
      'hypdriv.config': f(project.hypdrivConfigFile),
      'next.config': f(project.nextConfig?.file ?? null),
      proxy: f(project.proxyFile),
      instrumentation: f(project.instrumentationFile),
      ...(p === 'cloudflare'
        ? { 'worker entry': f(project.hypdrivWorkerFile), 'wrangler config': f(project.wrangler.configFile) }
        : {}),
      ...(p === 'vercel' ? { 'vercel config': f(project.vercel.configFile) } : {}),
      manifest: project.manifest ? '.hypdriv/manifest.json' : null,
    },
    config: { file: f(loaded.file), error: loaded.error, summary: configSummary(loaded.resolved) },
    build: {
      manifest: Boolean(manifest),
      buildId: manifest?.buildId ?? null,
      routes: manifest?.routes.length ?? 0,
      warnings: manifest?.warnings ?? [],
    },
    commands,
    issues,
    docs,
  };
}

/** Markdown rendering of the briefing. */
export function renderBriefing(b: AgentBriefing): string {
  const runtime = PLATFORM_RUNTIME_PACKAGE[b.project.platform];
  const lines: string[] = [];
  lines.push(`# HypDriv briefing — ${b.project.name}`);
  lines.push('');
  lines.push(
    `HypDriv is a sidecar for Next.js 16+: \`withHypDriv()\` in next.config, \`createProxy()\` in proxy.ts${b.project.platform === 'cloudflare' ? ', `createWorker()` in hypdriv.worker.ts (the Cloudflare Worker entry)' : ''}, all configured in \`hypdriv.config.ts\`. Never patch \`next\`, \`@opennextjs/*\` or \`wrangler\`; never hand-edit \`.hypdriv/\` (build output).`,
  );
  lines.push('');
  lines.push('## Project');
  lines.push('');
  lines.push(
    `- Platform: **${b.project.platform}**${b.project.platformSignals.cloudflare.length || b.project.platformSignals.vercel.length ? ` (signals: ${[...b.project.platformSignals.cloudflare, ...b.project.platformSignals.vercel].join(', ')})` : ''}${runtime ? ` · runtime package \`${runtime}\`` : ''}`,
  );
  lines.push(
    `- Package manager: ${b.project.packageManager} · router: ${[b.project.router.app ? 'App' : null, b.project.router.pages ? 'Pages' : null].filter(Boolean).join(' + ') || 'none found'}`,
  );
  lines.push(
    `- Versions: ${Object.entries(b.project.versions)
      .map(([k, v]) => `${k} ${v ?? '—'}`)
      .join(' · ')}`,
  );
  lines.push('');
  lines.push('## Files');
  lines.push('');
  for (const [k, v] of Object.entries(b.files)) lines.push(`- ${k}: ${v ? `\`${v}\`` : '_missing_'}`);
  lines.push('');
  lines.push('## Configuration');
  lines.push('');
  if (b.config.error) lines.push(`> hypdriv.config failed to load: ${b.config.error}`);
  for (const s of b.config.summary) lines.push(`- ${s}`);
  lines.push('');
  lines.push('## Build');
  lines.push('');
  lines.push(
    b.build.manifest
      ? `- Manifest: build \`${b.build.buildId}\`, ${b.build.routes} routes${b.build.warnings.length ? `, ${b.build.warnings.length} warning(s)` : ''}`
      : '- No manifest yet; build first.',
  );
  for (const w of b.build.warnings.slice(0, 10)) lines.push(`  - ${w}`);
  lines.push('');
  lines.push('## Open issues');
  lines.push('');
  if (!b.issues.length) lines.push('- None detected. Run `hypdriv doctor` for the full report.');
  for (const i of b.issues) lines.push(`- ${i}`);
  lines.push('');
  lines.push('## Commands');
  lines.push('');
  lines.push('| Command | Purpose |');
  lines.push('| --- | --- |');
  for (const c of b.commands) lines.push(`| \`${c.command}\` | ${c.purpose} |`);
  lines.push('');
  lines.push('## Rules of thumb');
  lines.push('');
  lines.push(
    '- Keep CSP in `auto` mode; add third parties with `security.csp.allow.*`, not by replacing `directives`.',
  );
  lines.push(
    '- Cache routes with `cache.edge.policies` (`ttl`, `swr`, `tags`) and purge with `revalidateTag()` from `hypdriv/cache`.',
  );
  lines.push(
    '- `proxy.ts` must export a literal `export const config = { matcher: [...] }`; Next.js rejects re-exports.',
  );
  if (b.project.platform === 'cloudflare')
    lines.push(
      '- Cron expressions in `jobs.cron` must also be in `wrangler.jsonc#triggers.crons` (`hypdriv doctor --fix`).',
    );
  if (b.project.platform === 'vercel')
    lines.push(
      '- Cron jobs must also be in `vercel.json#crons` and their routes must export GET (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).',
    );
  lines.push('- Every CLI command accepts `--json` and `--root <dir>`; exit code 1 means findings.');
  lines.push('');
  lines.push('## Docs');
  lines.push('');
  for (const d of b.docs) lines.push(`- [${d.title}](${d.url})`);
  lines.push('');
  return lines.join('\n');
}

export const agentCommand = defineCommand({
  name: 'agent',
  summary:
    'Print a Markdown briefing for coding agents: detected setup, configuration, open issues, commands, docs',
  usage: 'hypdriv agent [--json]',
  options: {},
  examples: ['hypdriv agent > HYPDRIV.md', 'hypdriv agent --json'],
  async run(args, io) {
    const ctx = createContext(args, io);
    const project = ctx.project();
    const loaded = await ctx.loadConfig();
    const briefing = buildBriefing(project, loaded);
    if (args.json) ctx.ui.printJson(briefing);
    else io.stdout.write(renderBriefing(briefing));
    return 0;
  },
});
