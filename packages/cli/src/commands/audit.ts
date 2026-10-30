import { silentLogger } from '@hypdriv/core';
import { UsageError } from '../args';
import { auditCache, type CacheAuditResult } from '../audit/cache';
import { type AuditLevel, auditCsp, type CspAuditResult } from '../audit/csp';
import { gradeHeaders, type HeaderGrade } from '../audit/headers';
import { type FetchedPage, fetchPage, joinUrl, mapConcurrent, normalizeBaseUrl } from '../audit/http';
import { type AuditPath, choosePaths, cspModeFor } from '../audit/paths';
import { CliError, createContext } from '../context';
import { loadNextAdapter, loadPurserNode } from '../integrations';
import type { Ui } from '../ui';
import { defineCommand } from './types';

export type AuditKind = 'headers' | 'csp' | 'cache' | 'css';
const KINDS: AuditKind[] = ['headers', 'csp', 'cache', 'css'];

export interface HeadersAuditEntry {
  path: string;
  status: number;
  redirected: string | null;
  error: string | null;
  grade: HeaderGrade | null;
  level: AuditLevel;
}

function levelOfGrade(g: HeaderGrade): AuditLevel {
  if (g.grade === 'A+' || g.grade === 'A') return g.deductions.length ? 'warn' : 'pass';
  if (g.grade === 'B') return 'warn';
  return 'fail';
}

function pageLevel(page: FetchedPage): AuditLevel | null {
  if (page.error) return 'fail';
  if (page.redirected) return 'warn';
  if (page.status >= 500) return 'fail';
  return null;
}

/** Headers audit over a list of fetched pages (pure; used by tests). */
export function auditHeadersPages(
  pages: Array<{ path: string; page: FetchedPage }>,
  https: boolean,
): HeadersAuditEntry[] {
  return pages.map(({ path, page }) => {
    const early = pageLevel(page);
    if (page.error)
      return { path, status: 0, redirected: null, error: page.error, grade: null, level: 'fail' };
    const grade = gradeHeaders(page.headers, { https });
    return {
      path,
      status: page.status,
      redirected: page.redirected,
      error: null,
      grade,
      level: early === 'fail' ? 'fail' : early === 'warn' ? 'warn' : levelOfGrade(grade),
    };
  });
}

export const auditCommand = defineCommand({
  name: 'audit',
  summary:
    'Audit a running server: security headers (A+ model), CSP validity, edge-cache behaviour, Purser zero-override check',
  usage:
    'hypdriv audit <headers|csp|cache|css|all> --url <base> [--paths a,b] [--limit 20] [--concurrency 4]',
  options: {
    url: {
      type: 'string',
      value: '<base>',
      description: 'Base URL of the server (e.g. http://localhost:8787)',
    },
    paths: {
      type: 'string',
      value: '<a,b>',
      description: 'Paths to audit (default: chosen from the manifest)',
      multiple: true,
    },
    limit: { type: 'string', value: '<n>', description: 'Maximum number of manifest paths', default: '20' },
    concurrency: { type: 'string', value: '<n>', description: 'Parallel requests', default: '4' },
    timeout: { type: 'string', value: '<ms>', description: 'Per-request timeout', default: '10000' },
    widths: {
      type: 'string',
      value: '<a,b>',
      description: 'css: viewport widths (default from hypdriv.config)',
    },
    states: {
      type: 'string',
      value: '<a,b>',
      description: 'css: default,hover,focus (default from hypdriv.config)',
    },
  },
  subcommands: [
    { name: 'headers', summary: 'Grade security headers like securityheaders.com' },
    { name: 'csp', summary: 'Validate the policy and nonce/hash coverage of inline scripts' },
    { name: 'cache', summary: 'Request twice; expect MISS then HIT/STALE, Age, Vary rsc' },
    { name: 'css', summary: 'Purser zero-override check in headless Chrome (needs @avonao/purser)' },
    { name: 'all', summary: 'headers + csp + cache (+ css when Purser is active)' },
  ],
  examples: [
    'hypdriv audit all --url http://localhost:8787',
    'hypdriv audit csp --url https://www.example.com --paths /,/pricing',
    'hypdriv audit cache --url http://localhost:8787 --json',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const kindArg = args.positionals[0];
    if (!kindArg || (kindArg !== 'all' && !KINDS.includes(kindArg as AuditKind)))
      throw new UsageError('audit needs one of: headers, csp, cache, css, all');
    const base = normalizeBaseUrl(args.string('url'));
    if (!base) throw new UsageError('--url <base> is required (e.g. --url http://localhost:8787)');
    const config = await ctx.loadConfig();
    const manifest = ctx.manifest();
    const purserActive = Boolean(
      config.resolved.purser &&
        (config.resolved.purser.enabled === true || ctx.project({ scan: false }).purser.installed),
    );
    const kinds: AuditKind[] =
      kindArg === 'all'
        ? purserActive
          ? ['headers', 'csp', 'cache', 'css']
          : ['headers', 'csp', 'cache']
        : [kindArg as AuditKind];
    const paths = choosePaths(manifest, {
      paths: args.list('paths'),
      limit: args.number('limit', 20, { min: 1 }),
    });
    const concurrency = args.number('concurrency', 4, { min: 1, max: 32 });
    const timeoutMs = args.number('timeout', 10_000, { min: 100 });
    const https = base.startsWith('https:');
    const fetchOpts = { fetch: io.fetch, timeoutMs };
    const results: Record<string, unknown> = {};
    let exit = 0;
    if (!manifest)
      ui.warn(
        'No .hypdriv/manifest.json; auditing / and --paths only (run next build for route-aware audits).',
      );

    // One fetch per path shared by headers and csp.
    let pages: Array<{ path: AuditPath; page: FetchedPage }> | null = null;
    const fetchAll = async () => {
      pages ??= await mapConcurrent(paths, concurrency, async (p) => ({
        path: p,
        page: await fetchPage(joinUrl(base, p.path), fetchOpts, io.now),
      }));
      return pages;
    };

    if (kinds.includes('headers')) {
      const fetched = await fetchAll();
      const entries = auditHeadersPages(
        fetched.map((f) => ({ path: f.path.path, page: f.page })),
        https,
      );
      results.headers = entries;
      if (entries.some((e) => e.level === 'fail')) exit = 1;
      printHeaders(ui, entries, base);
    }
    if (kinds.includes('csp')) {
      const adapter = await loadNextAdapter();
      const extractInlineScripts = adapter?.extractInlineScripts;
      const fetched = await fetchAll();
      const entries: CspAuditResult[] = fetched.map(({ path, page }) => {
        if (page.error)
          return {
            path: path.path,
            status: 'fail',
            mode: 'none',
            expected: cspModeFor(path.route, manifest),
            findings: [{ level: 'fail', message: page.error }],
            policy: null,
            scripts: { inline: 0, external: 0, withNonce: 0, hashed: 0, unmatched: 0 },
          };
        return auditCsp(
          {
            path: path.path,
            status: page.status,
            headers: page.headers,
            body: page.body,
            expected: cspModeFor(path.route, manifest),
          },
          extractInlineScripts ? { extractInlineScripts } : {},
        );
      });
      results.csp = entries;
      if (entries.some((e) => e.status === 'fail')) exit = 1;
      printCsp(ui, entries);
    }
    if (kinds.includes('cache')) {
      const entries: CacheAuditResult[] = await mapConcurrent(paths, concurrency, async (p) => {
        const url = joinUrl(base, p.path);
        const first = await fetchPage(url, fetchOpts, io.now);
        const second = await fetchPage(url, fetchOpts, io.now);
        if (first.error || second.error) {
          return {
            path: p.path,
            status: 'fail',
            hasPolicy: Boolean(p.route?.cachePolicyId),
            first: null,
            second: null,
            age: null,
            vary: null,
            cacheControl: null,
            findings: [{ level: 'fail', message: first.error ?? second.error ?? 'request failed' }],
          };
        }
        return auditCache({
          path: p.path,
          hasPolicy: Boolean(p.route?.cachePolicyId),
          first: { status: first.status, headers: first.headers },
          second: { status: second.status, headers: second.headers },
        });
      });
      results.cache = entries;
      if (entries.some((e) => e.status === 'fail')) exit = 1;
      printCache(ui, entries);
    }
    if (kinds.includes('css')) {
      const purser = config.resolved.purser;
      if (!purser)
        throw new CliError('audit css needs a Purser configuration (purser is false in hypdriv.config).');
      const mod = await loadPurserNode();
      if (!mod?.auditOverrides)
        throw new CliError('@hypdriv/purser/node does not provide auditOverrides in this installation.');
      const widths = args.string('widths')
        ? args
            .list('widths')
            .map(Number)
            .filter((n) => Number.isFinite(n) && n > 0)
        : purser.audit.widths;
      const states = (args.string('states') ? args.list('states') : purser.audit.states).filter(
        (s): s is 'default' | 'hover' | 'focus' => s === 'default' || s === 'hover' || s === 'focus',
      );
      const cssPaths =
        purser.audit.routes?.length && !args.list('paths').length
          ? purser.audit.routes
          : paths.map((p) => p.path);
      const themeClasses: string[][] = purser.theme
        ? [
            [],
            ...Object.values(purser.theme.axes).flatMap((axis) =>
              Object.values(axis.classes)
                .filter((c): c is string => typeof c === 'string')
                .map((c) => [c]),
            ),
          ]
        : [[]];
      ui.note(
        `Running Purser's strike-count audit on ${cssPaths.length} page(s) × ${widths.length} width(s) × ${states.length} state(s)…`,
      );
      try {
        const report = await mod.auditOverrides({
          urls: cssPaths.map((p) => joinUrl(base, p)),
          widths,
          states,
          projectDir: ctx.root,
          timeoutMs: Math.max(timeoutMs, 30_000),
          themeClasses,
          log: silentLogger,
        });
        results.css = report;
        if (!report.ok) exit = 1;
        printCss(ui, report, mod.formatAuditReport);
      } catch (err) {
        const e = err as Error & { code?: string };
        results.css = { ok: false, error: e.message };
        exit = 1;
        ui.status('fail', `css audit could not run: ${e.message}`);
      }
    }

    if (args.json) ui.printJson({ url: base, paths: paths.map((p) => p.path), ...results, ok: exit === 0 });
    else {
      ui.line();
      ui.status(exit ? 'fail' : 'pass', exit ? 'Audit found failures.' : 'Audit passed.');
    }
    return exit;
  },
});

function printHeaders(ui: Ui, entries: HeadersAuditEntry[], base: string): void {
  ui.heading(`Security headers  ${ui.color.dim(base)}`);
  ui.table(
    entries.map((e) => [
      ui.statusIcon(e.level),
      e.path,
      e.error ? 'ERR' : String(e.status),
      e.grade ? e.grade.grade : '—',
      e.grade ? String(e.grade.score) : '—',
      e.error ??
        (e.redirected
          ? `redirect → ${e.redirected}`
          : e.grade?.missing.length
            ? `missing: ${e.grade.missing.join(', ')}`
            : e.grade?.deductions.map((d) => d.reason).join('; ') || 'all core headers present'),
    ]),
    {
      columns: [
        '',
        'path',
        'status',
        'grade',
        { header: 'score', align: 'right' },
        { header: 'findings', maxWidth: 90 },
      ],
    },
  );
  const notes = new Set<string>();
  for (const e of entries) for (const n of e.grade?.notes ?? []) notes.add(n);
  if (notes.size) {
    ui.line();
    ui.note('Recommendations:');
    ui.list([...notes]);
  }
}

function printCsp(ui: Ui, entries: CspAuditResult[]): void {
  ui.heading('Content Security Policy');
  ui.table(
    entries.map((e) => [
      ui.statusIcon(e.status),
      e.path,
      e.mode,
      e.expected,
      `${e.scripts.inline}/${e.scripts.external}`,
      e.findings.map((f) => f.message).join('; ') || 'ok',
    ]),
    {
      columns: [
        '',
        'path',
        'mode',
        'expected',
        { header: 'inline/ext', align: 'right' },
        { header: 'findings', maxWidth: 90 },
      ],
    },
  );
}

function printCache(ui: Ui, entries: CacheAuditResult[]): void {
  ui.heading('Edge cache');
  ui.table(
    entries.map((e) => [
      ui.statusIcon(e.status),
      e.path,
      e.hasPolicy ? 'yes' : 'no',
      e.first ?? '—',
      e.second ?? '—',
      e.age ?? '—',
      e.cacheControl ?? '—',
      e.findings.map((f) => f.message).join('; ') || 'ok',
    ]),
    {
      columns: [
        '',
        'path',
        'policy',
        '1st',
        '2nd',
        'age',
        { header: 'cache-control', maxWidth: 40 },
        { header: 'findings', maxWidth: 80 },
      ],
    },
  );
}

function printCss(
  ui: Ui,
  report: {
    ok: boolean;
    pages: Array<{
      url: string;
      width: number;
      state: string;
      theme: string[];
      count: number;
      error?: string;
      skipped: string[];
    }>;
    chrome: { path: string; version: string };
    durationMs: number;
    checks: number;
  },
  format?: (r: never) => string,
): void {
  ui.heading(
    `Purser zero-override audit  ${ui.color.dim(`${report.chrome.version} · ${report.checks} checks · ${Math.round(report.durationMs)} ms`)}`,
  );
  ui.table(
    report.pages.map((p) => [
      ui.statusIcon(p.error ? 'fail' : p.count > 0 ? 'fail' : 'pass'),
      p.url,
      String(p.width),
      p.state,
      p.theme.join(' ') || '—',
      p.error ? 'ERR' : String(p.count),
      p.error ?? (p.skipped.length ? `skipped: ${p.skipped.join(', ')}` : ''),
    ]),
    {
      columns: [
        '',
        { header: 'url', maxWidth: 60 },
        { header: 'width', align: 'right' },
        'state',
        'theme',
        { header: 'overrides', align: 'right' },
        { header: 'notes', maxWidth: 60 },
      ],
    },
  );
  if (!report.ok && format) ui.line(format(report as never));
}
