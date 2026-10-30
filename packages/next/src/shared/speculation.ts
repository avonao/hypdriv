import type { HypManifest, ResolvedSpeculation } from '@hypdriv/core';
import { cspHash, matchesAny } from '@hypdriv/core';

type Where = Record<string, unknown>;

export interface SpeculationRules {
  prerender?: Array<Record<string, unknown>>;
  prefetch?: Array<Record<string, unknown>>;
}

function patternToHrefMatch(pattern: string, basePath: string): string {
  // Speculation Rules use URLPattern syntax; HypDriv patterns map onto it closely.
  let p = pattern
    .replace(/\\\?/g, '?')
    .replace(/\*\*/g, '*')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)\*/g, ':$1*')
    .replace(/^\^/, '');
  if (p.includes('?')) p = p.split('?')[0]!;
  return `${basePath}${p}`;
}

function where(include: string[], exclude: string[], basePath: string): Where {
  const conditions: Where[] = [];
  if (include.length === 1 && include[0] === '/*') conditions.push({ href_matches: `${basePath}/*` });
  else conditions.push({ or: include.map((i) => ({ href_matches: patternToHrefMatch(i, basePath) })) });
  if (exclude.length)
    conditions.push({ not: { href_matches: exclude.map((e) => patternToHrefMatch(e, basePath)) } });
  conditions.push({
    not: { selector_matches: '[data-no-speculate], [rel~=nofollow], [download], [target=_blank]' },
  });
  return conditions.length === 1 ? conditions[0]! : { and: conditions };
}

/** Builds the Speculation Rules document for a route (null when nothing applies). */
export function buildSpeculationRules(input: {
  manifest: Pick<HypManifest, 'speculation' | 'basePath'>;
  config: ResolvedSpeculation;
  pathname: string;
}): SpeculationRules | null {
  const { manifest, config, pathname } = input;
  const basePath = manifest.basePath ?? '';
  const rules: SpeculationRules = {};
  const exclude = [...config.exclude];
  const graphUrls = config.useGraph
    ? (manifest.speculation.graph[pathname] ?? []).filter((u) => !matchesAny(exclude, u))
    : [];

  if (config.prerender) {
    const list: Array<Record<string, unknown>> = [];
    const top = graphUrls.slice(0, config.prerender.topN).map((u) => `${basePath}${u}`);
    if (top.length) list.push({ source: 'list', urls: top, eagerness: 'eager' });
    list.push({
      where: where(config.prerender.include, [...exclude, ...config.prerender.exclude], basePath),
      eagerness: config.prerender.eagerness,
    });
    rules.prerender = list;
  }
  if (config.prefetch) {
    rules.prefetch = [
      {
        where: where(config.prefetch.include, [...exclude, ...config.prefetch.exclude], basePath),
        eagerness: config.prefetch.eagerness,
      },
    ];
  }
  if (!rules.prerender && !rules.prefetch) return null;
  return rules;
}

/** Deterministic JSON for the inline script (stable key order). */
export function speculationScript(rules: SpeculationRules): string {
  return JSON.stringify(rules);
}

/** CSP hash of the inline speculation script. */
export function speculationScriptHash(rules: SpeculationRules): Promise<string> {
  return cspHash(speculationScript(rules));
}

/**
 * The route-independent rules `<Speculation/>` renders (document rules only, no per-route link graph), so
 * the component needs no request data and stays prerenderable. The Worker replaces them at the edge with
 * the route's graph-aware rules.
 */
export function componentSpeculationRules(
  config: ResolvedSpeculation,
  basePath = '',
): SpeculationRules | null {
  return buildSpeculationRules({
    manifest: { speculation: { graph: {}, excluded: [] }, basePath },
    config: { ...config, useGraph: false },
    pathname: '/',
  });
}
