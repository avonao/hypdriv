import { readFileSync } from 'node:fs';
import { assertManifest, frameworkLabel, type HypManifest, manifestFramework } from '@hypdriv/core';
import { manifestPath } from '@hypdriv/core/node';
import { CliError, createContext } from '../context';
import { bytes } from '../ui';
import { exists } from '../util/fs';
import { defineCommand } from './types';

export interface ManifestIssue {
  level: 'error' | 'warn';
  path: string;
  message: string;
}

const HASH_RE = /^'sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}'$/;
const LINK_RE = /^<[^>]+>(?:\s*;\s*[a-zA-Z-]+(?:=(?:"[^"]*"|[^;,\s]+))?)+$/;

/** Structural validation (`assertManifest`) plus consistency cross-checks. */
export function validateManifest(value: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  try {
    assertManifest(value);
  } catch (err) {
    return [{ level: 'error', path: '$', message: (err as Error).message }];
  }
  const m = value as HypManifest;
  const ids = new Map<string, number>();
  m.routes.forEach((r, i) => {
    const p = `routes[${i}]`;
    if (!r.id) issues.push({ level: 'error', path: p, message: 'route without id' });
    ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
    if (typeof r.pathname !== 'string' || !r.pathname.startsWith('/'))
      issues.push({
        level: 'error',
        path: `${p}.pathname`,
        message: `invalid pathname ${JSON.stringify(r.pathname)}`,
      });
    if (r.dynamic) {
      try {
        new RegExp(r.regex);
      } catch (err) {
        issues.push({
          level: 'error',
          path: `${p}.regex`,
          message: `invalid regex: ${(err as Error).message}`,
        });
      }
    }
    if (!['static', 'isr', 'shell', 'dynamic', 'route', 'asset'].includes(r.classification))
      issues.push({
        level: 'error',
        path: `${p}.classification`,
        message: `unknown classification ${r.classification}`,
      });
    if (!r.assets || !Array.isArray(r.assets.js) || !Array.isArray(r.assets.css))
      issues.push({ level: 'error', path: `${p}.assets`, message: 'assets.js/css must be arrays' });
    if (
      r.classification === 'isr' &&
      !(typeof r.prerender?.revalidate === 'number' && r.prerender.revalidate > 0)
    )
      issues.push({
        level: 'warn',
        path: `${p}.prerender.revalidate`,
        message: 'isr route without a positive revalidate',
      });
    if (r.runtime === 'edge')
      issues.push({ level: 'warn', path: `${p}.runtime`, message: `${r.pathname} uses the Edge runtime` });
  });
  for (const [id, count] of ids)
    if (count > 1)
      issues.push({ level: 'error', path: 'routes', message: `duplicate route id ${id} (${count}×)` });
  for (const [key, value] of Object.entries(m.csp ?? {})) {
    const routeId = key.split('#')[0]!;
    if (!ids.has(routeId))
      issues.push({ level: 'warn', path: `csp.${key}`, message: 'hashes for an unknown route id' });
    for (const [kind, list] of [
      ['scriptHashes', value.scriptHashes],
      ['styleHashes', value.styleHashes],
    ] as const) {
      if (!Array.isArray(list)) {
        issues.push({ level: 'error', path: `csp.${key}.${kind}`, message: 'must be an array' });
        continue;
      }
      list.forEach((h, i) => {
        if (!HASH_RE.test(h))
          issues.push({
            level: 'error',
            path: `csp.${key}.${kind}[${i}]`,
            message: `malformed hash source ${h}`,
          });
      });
    }
  }
  for (const [id, links] of Object.entries(m.earlyHints ?? {})) {
    if (!ids.has(id))
      issues.push({ level: 'warn', path: `earlyHints.${id}`, message: 'hints for an unknown route id' });
    links.forEach((l, i) => {
      if (!LINK_RE.test(l.trim()))
        issues.push({
          level: 'error',
          path: `earlyHints.${id}[${i}]`,
          message: `unparseable Link value ${JSON.stringify(l)}`,
        });
    });
  }
  for (const id of Object.keys(m.weights?.client ?? {}))
    if (!ids.has(id))
      issues.push({
        level: 'warn',
        path: `weights.client.${id}`,
        message: 'weights for an unknown route id',
      });
  if (!m.weights || typeof m.weights.client !== 'object')
    issues.push({ level: 'error', path: 'weights.client', message: 'missing client weights' });
  if (m.purser) {
    for (const [id, atoms] of Object.entries(m.purser.missingAtoms))
      if (atoms.length)
        issues.push({
          level: 'error',
          path: `purser.missingAtoms.${id}`,
          message: `${atoms.length} atom(s) missing from the stylesheet`,
        });
  }
  if (Number.isNaN(Date.parse(m.generatedAt)))
    issues.push({ level: 'warn', path: 'generatedAt', message: 'not an ISO date' });
  return issues;
}

export const manifestCommand = defineCommand({
  name: 'manifest',
  summary: 'Print or validate .hypdriv/manifest.json',
  usage: 'hypdriv manifest [--validate] [--summary]',
  options: {
    validate: {
      type: 'boolean',
      description: 'Validate the structure and cross-check ids, CSP hashes and Early Hints',
    },
    summary: { type: 'boolean', description: 'Print a short summary instead of the full document' },
  },
  examples: [
    'hypdriv manifest --summary',
    'hypdriv manifest --validate --json',
    'hypdriv manifest > manifest.json',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const file = manifestPath(ctx.root);
    if (!exists(file))
      throw new CliError('No .hypdriv/manifest.json found. Run `next build` (with withHypDriv) first.');
    let parsed: unknown;
    const text = readFileSync(file, 'utf8');
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new CliError(`.hypdriv/manifest.json is not valid JSON: ${(err as Error).message}`);
    }
    if (args.boolean('validate')) {
      const issues = validateManifest(parsed);
      const errors = issues.filter((i) => i.level === 'error');
      if (args.json) ui.printJson({ file, valid: errors.length === 0, issues });
      else {
        ui.heading('Manifest validation');
        if (!issues.length)
          ui.status('pass', 'Manifest is valid; ids, hashes and Early Hints are consistent.');
        for (const i of issues) ui.status(i.level === 'error' ? 'fail' : 'warn', i.path, i.message);
      }
      return errors.length ? 1 : 0;
    }
    if (args.boolean('summary')) {
      const m = parsed as HypManifest;
      const counts: Record<string, number> = {};
      for (const r of m.routes ?? []) counts[r.classification] = (counts[r.classification] ?? 0) + 1;
      const summary = {
        buildId: m.buildId,
        nextVersion: m.nextVersion ?? null,
        framework: manifestFramework(m),
        hypdrivVersion: m.hypdrivVersion,
        generatedAt: m.generatedAt,
        cacheComponents: m.cacheComponents,
        routes: m.routes?.length ?? 0,
        classifications: counts,
        csp: Object.keys(m.csp ?? {}).length,
        earlyHints: Object.keys(m.earlyHints ?? {}).length,
        purser: m.purser ? { atoms: m.purser.atoms, unused: m.purser.unusedAtoms.length } : null,
        worker: m.weights?.worker ? { raw: m.weights.worker.raw, gzip: m.weights.worker.gzip } : null,
        warnings: m.warnings?.length ?? 0,
        bytes: Buffer.byteLength(text),
      };
      if (args.json) ui.printJson(summary);
      else {
        ui.heading(`Manifest ${ui.color.dim(file)}`);
        ui.kv([
          ['build', `${summary.buildId} · ${frameworkLabel(m)} · Hypdriv ${summary.hypdrivVersion}`],
          ['generated', summary.generatedAt],
          [
            'routes',
            `${summary.routes} (${Object.entries(counts)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')})`,
          ],
          ['CSP hash sets', summary.csp],
          ['Early Hints', `${summary.earlyHints} route(s)`],
          ['Purser', summary.purser ? `${summary.purser.atoms} atoms, ${summary.purser.unused} unused` : '—'],
          [
            'worker',
            summary.worker ? `${bytes(summary.worker.raw)} raw · ${bytes(summary.worker.gzip)} gzip` : '—',
          ],
          ['warnings', summary.warnings],
          ['size', bytes(summary.bytes)],
        ]);
      }
      return 0;
    }
    // Full document: printed as-is in both modes (it is JSON already).
    io.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
    return 0;
  },
});
