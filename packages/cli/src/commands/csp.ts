import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CspDirectives, HypManifest, HypRoute } from '@hypdriv/core';
import { UsageError } from '../args';
import { findRoute } from '../audit/paths';
import { CliError, createContext } from '../context';
import { type CspReportLike, loadSecurity, missingExport } from '../integrations';
import { defineCommand } from './types';

/** Routes with hashes in the manifest (`csp` keys may be `<routeId>` or `<routeId>#<concrete path>`). */
export function hashEntries(
  manifest: HypManifest,
  routeFilter?: HypRoute | null,
): Array<{ key: string; route: string; path: string | null; scriptHashes: string[]; styleHashes: string[] }> {
  const out: Array<{
    key: string;
    route: string;
    path: string | null;
    scriptHashes: string[];
    styleHashes: string[];
  }> = [];
  for (const [key, value] of Object.entries(manifest.csp)) {
    const [routeId, concrete] = key.split('#') as [string, string | undefined];
    if (routeFilter && routeId !== routeFilter.id) continue;
    const route = manifest.routes.find((r) => r.id === routeId);
    out.push({
      key,
      route: route?.pathname ?? routeId,
      path: concrete ?? null,
      scriptHashes: value.scriptHashes,
      styleHashes: value.styleHashes,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Parses newline-delimited JSON reports (CspReport objects or raw browser report bodies). */
export function readReports(
  text: string,
  normalize?: (body: unknown) => CspReportLike | null,
): { reports: CspReportLike[]; invalid: number } {
  const reports: CspReportLike[] = [];
  let invalid = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid++;
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const candidate =
        item && typeof item === 'object' && 'csp-report' in (item as object)
          ? (item as Record<string, unknown>)['csp-report']
          : item &&
              typeof item === 'object' &&
              'body' in (item as object) &&
              (item as Record<string, unknown>).type === 'csp-violation'
            ? (item as Record<string, unknown>).body
            : item;
      const direct = candidate as Partial<CspReportLike>;
      if (direct && typeof direct.effectiveDirective === 'string' && typeof direct.blockedUri === 'string') {
        reports.push({
          ...(direct as CspReportLike),
          documentUri: direct.documentUri ?? '',
          violatedDirective: direct.violatedDirective ?? direct.effectiveDirective,
          disposition: direct.disposition ?? 'enforce',
          ts: direct.ts ?? 0,
        });
        continue;
      }
      const normalized = normalize?.(candidate) ?? null;
      if (normalized) reports.push(normalized);
      else invalid++;
    }
  }
  return { reports, invalid };
}

function formatDirectives(directives: CspDirectives): string[] {
  return Object.entries(directives)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? k : `${k} ${(v as string[]).join(' ')}`));
}

export const cspCommand = defineCommand({
  name: 'csp',
  summary: 'Static route hashes, allow-list suggestions from violation reports, and the effective policy',
  usage: 'hypdriv csp <hashes|suggest|print> [--route <path>] [--reports <file.ndjson>] [--dev]',
  options: {
    route: {
      type: 'string',
      value: '<path>',
      description: 'Route pattern or concrete path (e.g. / or /blog/hello)',
    },
    reports: {
      type: 'string',
      value: '<file>',
      description: 'suggest: NDJSON file of CSP reports (from the /_hypdriv/csp-report sink)',
    },
    dev: { type: 'boolean', description: "print: the development policy ('unsafe-eval', ws: HMR)" },
    origin: {
      type: 'string',
      value: '<url>',
      description: 'print: request origin (development connect-src)',
    },
  },
  subcommands: [
    { name: 'hashes', summary: 'Inline script/style hashes per static route from the manifest' },
    { name: 'suggest', summary: 'Aggregate violation reports into allow-list additions' },
    {
      name: 'print',
      summary: 'The effective policy for a route (hashes for static routes, a placeholder nonce otherwise)',
    },
  ],
  examples: [
    'hypdriv csp hashes --route /',
    'hypdriv csp suggest --reports csp-reports.ndjson',
    'hypdriv csp print --route /blog/hello-world',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const sub = args.positionals[0];
    if (sub !== 'hashes' && sub !== 'suggest' && sub !== 'print')
      throw new UsageError('csp needs a subcommand: hashes, suggest or print');
    const routeArg = args.string('route');

    if (sub === 'hashes') {
      const manifest = ctx.requireManifest();
      const route = routeArg ? findRoute(manifest, routeArg) : null;
      if (routeArg && !route) throw new CliError(`no route in the manifest matches ${routeArg}`);
      const entries = hashEntries(manifest, route);
      if (args.json) {
        ui.printJson({ buildId: manifest.buildId, routes: entries });
        return 0;
      }
      ui.heading(`CSP hashes — build ${manifest.buildId}`);
      if (!entries.length)
        ui.note(
          route
            ? `${route.pathname} is not a hash-mode route (classification ${route.classification}); it uses nonces.`
            : 'No static routes with inline content in the manifest.',
        );
      for (const e of entries) {
        ui.subheading(
          `${e.route}${e.path ? ` → ${e.path}` : ''}  ${ui.color.dim(`${e.scriptHashes.length} script · ${e.styleHashes.length} style`)}`,
        );
        for (const h of e.scriptHashes) ui.line(`  script-src ${h}`);
        for (const h of e.styleHashes) ui.line(`  style-src  ${h}`);
      }
      return 0;
    }

    const config = await ctx.loadConfig();
    const csp = config.resolved.security.csp;
    if (!csp) throw new CliError('CSP is disabled in hypdriv.config (security.csp: false).');
    const security = await loadSecurity();

    if (sub === 'suggest') {
      const file = args.string('reports');
      if (!file)
        throw new UsageError('csp suggest needs --reports <file.ndjson> (one CSP report JSON per line)');
      if (!security?.suggestPolicy) throw new CliError(missingExport('@hypdriv/security', 'suggestPolicy'));
      let text: string;
      try {
        text = readFileSync(resolve(io.cwd, file), 'utf8');
      } catch (err) {
        throw new CliError(`cannot read ${file}: ${(err as Error).message}`);
      }
      const { reports, invalid } = readReports(text, security.normalizeCspReport);
      const result = security.suggestPolicy(reports, csp.directives);
      if (args.json) {
        ui.printJson({
          reports: reports.length,
          invalid,
          additions: result.additions,
          directives: result.directives,
        });
        return 0;
      }
      ui.heading(
        `CSP suggestions from ${reports.length} report(s)${invalid ? ` (${invalid} unreadable lines skipped)` : ''}`,
      );
      if (!result.additions.length) {
        ui.status('pass', 'No allow-list additions needed (inline/eval and extension noise are ignored).');
        return 0;
      }
      ui.table(
        result.additions.map((a) => [a.directive, a.source, String(a.count)]),
        { columns: ['directive', 'source', { header: 'reports', align: 'right' }] },
      );
      const byShorthand: Record<string, string> = {
        'script-src': 'scripts',
        'style-src': 'styles',
        'img-src': 'images',
        'font-src': 'fonts',
        'connect-src': 'connect',
        'frame-src': 'frames',
        'media-src': 'media',
        'worker-src': 'workers',
        'frame-ancestors': 'frameAncestors',
        'form-action': 'formAction',
      };
      const allow: Record<string, string[]> = {};
      for (const a of result.additions) {
        const key = byShorthand[a.directive];
        if (!key) continue;
        allow[key] = [...(allow[key] ?? []), a.source];
      }
      ui.line();
      ui.note('Add to hypdriv.config.ts (review each origin first):');
      ui.line(
        `  security: { csp: { allow: ${JSON.stringify(allow)
          .replace(/"([a-zA-Z]+)":/g, '$1: ')
          .replace(/"/g, "'")} } }`,
      );
      return 0;
    }

    // print
    if (!security?.buildCspHeader) throw new CliError(missingExport('@hypdriv/security', 'buildCspHeader'));
    const manifest = ctx.manifest();
    const route = routeArg && manifest ? findRoute(manifest, routeArg) : null;
    if (routeArg && manifest && !route) throw new CliError(`no route in the manifest matches ${routeArg}`);
    const concreteKey = route && routeArg ? `${route.id}#${routeArg}` : null;
    const hashes =
      route && manifest ? (concreteKey && manifest.csp[concreteKey]) || manifest.csp[route.id] : undefined;
    const forced = route
      ? csp.routes.find((r) =>
          (Array.isArray(r.match) ? r.match : [r.match]).some(
            (m) => typeof m === 'string' && (m === route.pathname || m === routeArg),
          ),
        )?.mode
      : undefined;
    if (csp.mode === 'off' || forced === 'off')
      throw new CliError(`CSP mode is off${forced ? ` for ${route?.pathname}` : ''}; nothing is emitted.`);
    let mode: 'hash' | 'nonce';
    if (forced === 'hash' || forced === 'nonce') mode = forced;
    else if (csp.mode === 'hash' || csp.mode === 'nonce') mode = csp.mode;
    else mode = route?.classification === 'static' && hashes ? 'hash' : 'nonce';
    const nonce = 'NONCE_PLACEHOLDER';
    const header = security.buildCspHeader({
      config: csp,
      mode,
      ...(mode === 'nonce' ? { nonce } : {}),
      ...(mode === 'hash' ? { hashes: hashes ?? { scriptHashes: [], styleHashes: [] } } : {}),
      development: args.boolean('dev'),
      origin: args.string('origin') ?? config.resolved.site.origin,
    });
    const headerName =
      csp.reportOnly === true ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
    if (args.json) {
      ui.printJson({
        route: route?.pathname ?? null,
        mode,
        header: headerName,
        policy: header,
        reportOnly: csp.reportOnly,
        directives: security.parseCsp?.(header) ?? null,
      });
      return 0;
    }
    ui.heading(
      `${headerName} — ${route ? `${route.pathname} (${route.classification})` : 'default'} · ${mode} mode${args.boolean('dev') ? ' · development' : ''}`,
    );
    const directives = security.parseCsp?.(header);
    if (directives) for (const line of formatDirectives(directives)) ui.line(`  ${line}`);
    ui.line();
    ui.line(header);
    if (mode === 'nonce') ui.note(`\n${nonce} is replaced by a fresh per-request nonce at run time.`);
    if (csp.reportOnly === 'both')
      ui.note('reportOnly: both — a stricter report-only policy is sent alongside the enforced one.');
    if (!manifest) ui.note('No manifest: hashes for static routes are unknown until `next build`.');
    return 0;
  },
});
