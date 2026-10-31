import { manifestFramework, silentLogger } from '@hypdriv/core';
import { rawList, UsageError } from '../args';
import { auditCache, type CacheAuditResult } from '../audit/cache';
import { type AuditLevel, auditCsp, type CspAuditResult } from '../audit/csp';
import { gradeHeaders, type HeaderGrade } from '../audit/headers';
import {
  cookiesFrom,
  type FetchedPage,
  fetchPage,
  joinUrl,
  mapConcurrent,
  normalizeBaseUrl,
} from '../audit/http';
import {
  type HttpsAuditEntry,
  httpsAuditable,
  httpsProbes,
  judgeHttpsProbe,
  plainHttpUrl,
} from '../audit/https';
import { type AuditPath, choosePaths, cspModeFor } from '../audit/paths';
import { type AuditAuth, auditAuth, describeAuditAuth } from '../audit/token';
import { CliError, createContext } from '../context';
import { loadNextAdapter, loadPurserNode } from '../integrations';
import type { Ui } from '../ui';
import { defineCommand } from './types';

export type AuditKind = 'headers' | 'csp' | 'cache' | 'https' | 'css';
const KINDS: AuditKind[] = ['headers', 'csp', 'cache', 'https', 'css'];

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
  if (page.status >= 500 || blockedByShield(page)) return 'fail';
  if (page.status >= 400) return 'warn';
  return null;
}

/** `true` when HypDriv's bot shield or rate limiter answered instead of the application. */
export function blockedByShield(page: Pick<FetchedPage, 'status' | 'headers'>): boolean {
  return (
    (page.status === 403 && page.headers.has('x-hypdriv-bot')) ||
    (page.status === 429 && (page.headers.has('ratelimit') || page.headers.has('x-hypdriv-bot')))
  );
}

/** Explains a 403/429 from the shield, pointing at the audit token when requests were unsigned. */
export function shieldHint(page: Pick<FetchedPage, 'status' | 'headers'>, auth?: AuditAuth | null): string {
  const who =
    page.status === 429
      ? 'rate limited'
      : `blocked by the bot shield (x-hypdriv-bot: ${page.headers.get('x-hypdriv-bot')})`;
  if (!auth || auth.source) return `${page.status} ${who}`;
  return `${page.status} ${who}; set ${auth.secretName} so the CLI signs its requests`;
}

/** Headers audit over a list of fetched pages (pure; used by tests). */
export function auditHeadersPages(
  pages: Array<{ path: string; page: FetchedPage }>,
  https: boolean,
  auth?: AuditAuth | null,
): HeadersAuditEntry[] {
  return pages.map(({ path, page }) => {
    const early = pageLevel(page);
    if (page.error)
      return { path, status: 0, redirected: null, error: page.error, grade: null, level: 'fail' };
    if (blockedByShield(page))
      return {
        path,
        status: page.status,
        redirected: null,
        error: shieldHint(page, auth),
        grade: null,
        level: 'fail',
      };
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
    'Audit a running server: security headers (A+ model), CSP validity, edge-cache behaviour, HTTPS enforcement, Purser zero-override check',
  usage:
    'hypdriv audit <headers|csp|cache|https|css|all> --url <base> [--paths a,b] [--limit 20] [--concurrency 4]',
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
    anonymous: {
      type: 'boolean',
      description: 'Send unsigned requests (no x-hypdriv-audit token), exactly as an anonymous visitor would',
    },
    header: {
      type: 'string',
      value: '<name: value>',
      description:
        'Extra request header for a gateway in front of the deployment (repeatable; also HYPDRIV_ACCESS_HEADERS, CF_ACCESS_CLIENT_ID/SECRET, VERCEL_AUTOMATION_BYPASS_SECRET)',
      multiple: true,
    },
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
    {
      name: 'https',
      summary: 'Pages, internal routes and assets over http:// must redirect to https (https deployments)',
    },
    { name: 'css', summary: 'Purser zero-override check in headless Chrome (needs @avonao/purser)' },
    {
      name: 'all',
      summary: 'headers + csp + cache (+ https for an https deployment, + css when Purser is active)',
    },
  ],
  examples: [
    'hypdriv audit all --url http://localhost:8787',
    'hypdriv audit csp --url https://www.example.com --paths /,/pricing',
    'hypdriv audit cache --url http://localhost:8787 --json',
    'hypdriv audit https --url https://www.example.com',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const kindArg = args.positionals[0];
    if (!kindArg || (kindArg !== 'all' && !KINDS.includes(kindArg as AuditKind)))
      throw new UsageError('audit needs one of: headers, csp, cache, https, css, all');
    const base = normalizeBaseUrl(args.string('url'));
    if (!base) throw new UsageError('--url <base> is required (e.g. --url http://localhost:8787)');
    const config = await ctx.loadConfig();
    const manifest = ctx.manifest();
    const purserActive = Boolean(
      config.resolved.purser &&
        (config.resolved.purser.enabled === true || ctx.project({ scan: false }).purser.installed),
    );
    if (kindArg === 'https' && !httpsAuditable(base))
      throw new UsageError(
        'audit https needs the https URL of a deployment (local previews run plain HTTP and are exempt).',
      );
    const kinds: AuditKind[] =
      kindArg === 'all'
        ? [
            'headers',
            'csp',
            'cache',
            ...(httpsAuditable(base) ? (['https'] as const) : []),
            ...(purserActive ? (['css'] as const) : []),
          ]
        : [kindArg as AuditKind];
    const paths = choosePaths(manifest, {
      paths: args.list('paths'),
      limit: args.number('limit', 20, { min: 1 }),
    });
    const concurrency = args.number('concurrency', 4, { min: 1, max: 32 });
    const timeoutMs = args.number('timeout', 10_000, { min: 100 });
    const https = base.startsWith('https:');
    // Cached HTML must vary on `rsc` only where HTML and RSC payloads share URLs (Next.js).
    const rscVary = ((manifest ? manifestFramework(manifest)?.name : undefined) ?? 'next') === 'next';
    const auth = await auditAuth({
      root: ctx.root,
      io,
      base,
      secretName: config.resolved.security.internalAuth.secretEnv,
      anonymous: args.boolean('anonymous'),
      headers: rawList(args, 'header'),
    });
    if (!args.json) ui.note(describeAuditAuth(auth));
    const fetchOpts = { fetch: io.fetch, timeoutMs, headers: auth.headers };
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
        auth,
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
        if (page.error || blockedByShield(page))
          return {
            path: path.path,
            status: 'fail',
            mode: 'none',
            expected: cspModeFor(path.route, manifest),
            findings: [{ level: 'fail', message: page.error ?? shieldHint(page, auth) }],
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
        // A repeat visit carries the cookies the first response set (flags bucketing, sessions), as a
        // browser would; a first visit that sets a cookie is not cacheable, so it primes once more.
        const cookie = cookiesFrom(first.headers);
        const repeatOpts = cookie ? { ...fetchOpts, headers: { ...fetchOpts.headers, cookie } } : fetchOpts;
        if (cookie) await fetchPage(url, repeatOpts, io.now);
        const second = await fetchPage(url, repeatOpts, io.now);
        const blocked = [first, second].find((r) => !r.error && blockedByShield(r));
        if (first.error || second.error || blocked) {
          return {
            path: p.path,
            status: 'fail',
            hasPolicy: Boolean(p.route?.cachePolicyId),
            first: null,
            second: null,
            age: null,
            vary: null,
            cacheControl: null,
            findings: [
              {
                level: 'fail',
                message:
                  first.error ?? second.error ?? (blocked ? shieldHint(blocked, auth) : 'request failed'),
              },
            ],
          };
        }
        return auditCache({
          path: p.path,
          hasPolicy: Boolean(p.route?.cachePolicyId),
          ...(p.route?.servedStatically ? { servedStatically: true } : {}),
          rscVary,
          first: { status: first.status, headers: first.headers },
          second: { status: second.status, headers: second.headers },
        });
      });
      results.cache = entries;
      if (entries.some((e) => e.status === 'fail')) exit = 1;
      printCache(ui, entries);
    }
    if (kinds.includes('https')) {
      const fetched = await fetchAll();
      const probes = httpsProbes(
        fetched.map((f) => ({ path: f.path.path, page: f.page })),
        base,
        config.resolved.cloudflare.internalPathPrefix,
      );
      // Anonymous on purpose: gateway headers and the audit token never cross the network in clear text.
      const entries: HttpsAuditEntry[] = await mapConcurrent(probes, concurrency, async (probe) =>
        judgeHttpsProbe(
          probe,
          base,
          await fetchPage(plainHttpUrl(base, probe.path), { fetch: io.fetch, timeoutMs }, io.now),
        ),
      );
      results.https = entries;
      if (entries.some((e) => e.level === 'fail')) exit = 1;
      printHttps(ui, entries);
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
          headers: auth.headers,
          log: silentLogger,
        });
        results.css = report;
        if (!report.ok) exit = 1;
        printCss(ui, report, mod.formatAuditReport);
        if (!auth.source && report.pages.some((p) => /^HTTP (403|429)\b/.test(p.error ?? '')))
          ui.warn(
            `Pages answered 403/429 to headless Chrome — HypDriv's bot shield or rate limiter refused the audit. Set ${auth.secretName} (environment, .dev.vars or .env.local) so the CLI signs its requests.`,
          );
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

function printHttps(ui: Ui, entries: HttpsAuditEntry[]): void {
  ui.heading('HTTPS enforcement (plain-HTTP requests)');
  ui.table(
    entries.map((e) => [
      ui.statusIcon(e.level),
      e.kind,
      e.path,
      e.status ? String(e.status) : 'ERR',
      e.finding,
    ]),
    { columns: ['', 'kind', 'path', 'status', { header: 'findings', maxWidth: 100 }] },
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
