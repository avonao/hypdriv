import type { HypManifest, HypRoute } from '@hypdriv/core';
import { cspModeFor } from '../audit/paths';

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
      const w = manifest.weights?.client?.[r.id];
      return {
        id: r.id,
        route: r.pathname,
        kind: r.kind,
        classification: r.classification,
        revalidate: r.prerender?.revalidate ?? null,
        cachePolicy: r.cachePolicyId ?? null,
        csp: cspModeFor(r, manifest),
        hints: manifest.earlyHints?.[r.id]?.length ?? 0,
        js: w ? w.js : null,
        css: w ? w.css : null,
        atoms: manifest.purser ? (manifest.purser.atomsByRoute[r.id]?.length ?? 0) : null,
        prerenderedPaths: r.prerender?.pathCount ?? r.prerender?.paths?.length ?? null,
      };
    });
}
