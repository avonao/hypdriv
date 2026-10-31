import type { HypManifest } from '@hypdriv/core';

/** `/about/` → `/about`, `/about/index.html` → `/about`, `/` stays `/`. */
export function normalizeRequestPath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // keep the raw path
  }
  if (path.endsWith('/index.html')) path = path.slice(0, -'index.html'.length);
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  return path || '/';
}

/** The pathnames of the documents the build prerendered (static pages and every listed prerendered path). */
export function prerenderedPaths(manifest: HypManifest): Set<string> {
  const out = new Set<string>();
  for (const route of manifest.routes) {
    if (route.kind !== 'page' && route.kind !== 'app-page') continue;
    // A dynamic page with some prerendered paths renders the others per request.
    for (const path of route.prerender?.paths ?? []) out.add(normalizeRequestPath(path));
    if (route.dynamic) continue;
    if (route.classification === 'static' || route.classification === 'isr')
      out.add(normalizeRequestPath(route.pathname));
  }
  return out;
}
