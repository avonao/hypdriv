import type { HypManifest, HypRoute } from '@hypdriv/core';
import { cspModeFor } from '../audit/paths';
import { createContext } from '../context';
import { bytes } from '../ui';
import { defineCommand } from './types';

const HIDDEN = new Set(['/_not-found', '/_global-error', '/_error']);

export interface RouteRow {
  id: string;
  route: string;
  kind: HypRoute['kind'];
  classification: HypRoute['classification'];
  revalidate: number | false | null;
  cachePolicy: string | null;
  csp: 'hash' | 'nonce' | 'none';
  hints: number;
  js: number | null;
  css: number | null;
  atoms: number | null;
  prerenderedPaths: number | null;
}

/** Table rows for the manifest's routes. */
export function routeRows(manifest: HypManifest, options: { all?: boolean } = {}): RouteRow[] {
  return manifest.routes
    .filter((r) => r.kind !== 'static-file' && (options.all || !HIDDEN.has(r.pathname)))
    .map((r) => {
      const w = manifest.weights.client[r.id];
      return {
        id: r.id,
        route: r.pathname,
        kind: r.kind,
        classification: r.classification,
        revalidate: r.prerender?.revalidate ?? null,
        cachePolicy: r.cachePolicyId ?? null,
        csp: cspModeFor(r, manifest),
        hints: manifest.earlyHints[r.id]?.length ?? 0,
        js: w ? w.js : null,
        css: w ? w.css : null,
        atoms: manifest.purser ? (manifest.purser.atomsByRoute[r.id]?.length ?? 0) : null,
        prerenderedPaths: r.prerender?.pathCount ?? r.prerender?.paths?.length ?? null,
      };
    });
}

function revalidateLabel(v: RouteRow['revalidate']): string {
  if (v === null) return '—';
  if (v === false) return 'never';
  return `${v}s`;
}

export const routesCommand = defineCommand({
  name: 'routes',
  summary:
    'Table of routes from the manifest: classification, revalidate, cache policy, CSP mode, hints, JS/CSS, Purser atoms',
  usage: 'hypdriv routes [--css] [--cache] [--csp] [--all]',
  options: {
    css: { type: 'boolean', description: 'Add Purser atom counts and unused atoms' },
    cache: { type: 'boolean', description: 'Add cache policy details (ttl/swr/tags)' },
    csp: { type: 'boolean', description: 'Add CSP hash counts per route' },
    all: { type: 'boolean', description: 'Include _not-found and _global-error' },
  },
  examples: ['hypdriv routes', 'hypdriv routes --css --json'],
  async run(args, io) {
    const ctx = createContext(args, io);
    const manifest = ctx.requireManifest();
    const config = await ctx.loadConfig();
    const rows = routeRows(manifest, { all: args.boolean('all') });
    const policies = new Map((config.resolved.cache.edge?.policies ?? []).map((p) => [p.id, p]));
    const inferred = config.resolved.cache.edge?.inferredStatic;
    if (args.json) {
      ctx.ui.printJson({
        buildId: manifest.buildId,
        nextVersion: manifest.nextVersion,
        cacheComponents: manifest.cacheComponents,
        routes: rows.map((r) => ({
          ...r,
          ...(args.boolean('csp')
            ? {
                cspHashes: manifest.csp[r.id]
                  ? {
                      scripts: manifest.csp[r.id]!.scriptHashes.length,
                      styles: manifest.csp[r.id]!.styleHashes.length,
                    }
                  : null,
              }
            : {}),
          ...(args.boolean('cache') && r.cachePolicy
            ? { policy: policyDetail(r.cachePolicy, policies, inferred) }
            : {}),
          ...(args.boolean('css') && manifest.purser
            ? { atomList: manifest.purser.atomsByRoute[r.id] ?? [] }
            : {}),
        })),
        ...(args.boolean('css') && manifest.purser
          ? {
              purser: {
                stylesheet: manifest.purser.stylesheet,
                atoms: manifest.purser.atoms,
                unusedAtoms: manifest.purser.unusedAtoms,
                missingAtoms: manifest.purser.missingAtoms,
              },
            }
          : {}),
      });
      return 0;
    }
    const { ui } = ctx;
    ui.heading(
      `Routes — build ${manifest.buildId} · Next ${manifest.nextVersion} · ${rows.length} routes${manifest.cacheComponents ? ' · Cache Components on' : ''}`,
    );
    const columns: Array<string | { header: string; align?: 'left' | 'right' }> = [
      'route',
      'kind',
      'class',
      'revalidate',
      'cache policy',
      'csp',
      { header: 'hints', align: 'right' },
      { header: 'JS', align: 'right' },
      { header: 'CSS', align: 'right' },
    ];
    if (args.boolean('css')) columns.push({ header: 'atoms', align: 'right' });
    if (args.boolean('csp')) columns.push({ header: 'hashes', align: 'right' });
    if (args.boolean('cache')) columns.push('ttl/swr');
    ui.table(
      rows.map((r) => {
        const cells: Array<string | number> = [
          r.route,
          r.kind,
          r.classification + (r.prerenderedPaths && r.prerenderedPaths > 0 ? ` (${r.prerenderedPaths})` : ''),
          revalidateLabel(r.revalidate),
          r.cachePolicy ?? '—',
          r.csp === 'none' ? '—' : r.csp,
          r.hints,
          bytes(r.js),
          bytes(r.css),
        ];
        if (args.boolean('css')) cells.push(r.atoms === null ? '—' : r.atoms);
        if (args.boolean('csp'))
          cells.push(
            manifest.csp[r.id]
              ? `${manifest.csp[r.id]!.scriptHashes.length}+${manifest.csp[r.id]!.styleHashes.length}`
              : '—',
          );
        if (args.boolean('cache')) {
          const d = r.cachePolicy ? policyDetail(r.cachePolicy, policies, inferred) : null;
          cells.push(d ? `${d.ttl}s/${d.swr}s${d.tags.length ? ` [${d.tags.join(',')}]` : ''}` : '—');
        }
        return cells;
      }),
      { columns },
    );
    if (args.boolean('css')) {
      ui.line();
      if (!manifest.purser) ui.note('No Purser section in the manifest (Purser inactive at build time).');
      else {
        ui.kv([
          [
            'stylesheet',
            `${manifest.purser.stylesheet} (${manifest.purser.atoms} atoms, hash ${manifest.purser.stylesheetHash})`,
          ],
          [
            'unused atoms',
            manifest.purser.unusedAtoms.length
              ? manifest.purser.unusedAtoms.slice(0, 40).join(' ') +
                (manifest.purser.unusedAtoms.length > 40 ? ' …' : '')
              : 'none',
          ],
          ['missing atoms', Object.values(manifest.purser.missingAtoms).flat().length || 'none'],
        ]);
      }
    }
    if (manifest.warnings.length) {
      ui.line();
      for (const w of manifest.warnings) ui.warn(w);
    }
    return 0;
  },
});

function policyDetail(
  id: string,
  policies: Map<string, { ttl: number; swr: number; tags: string[]; staleIfError: number }>,
  inferred: { ttl: number; swr: number; staleIfError: number } | undefined,
): {
  ttl: number;
  swr: number;
  staleIfError: number;
  tags: string[];
  source: 'explicit' | 'inferred';
} | null {
  const p = policies.get(id);
  if (p) return { ttl: p.ttl, swr: p.swr, staleIfError: p.staleIfError, tags: p.tags, source: 'explicit' };
  if (id.startsWith('inferred:') && inferred)
    return { ...inferred, tags: [`route:${id.slice('inferred:'.length)}`], source: 'inferred' };
  return null;
}
