import type { HypManifest, HypRoute } from '@hypdriv/core';
import { type ManifestSource, readManifestFile } from '@hypdriv/runtime';

/**
 * The manifest as a runner in front of TanStack Start's renderer sees it. A request that reaches Start is rendered
 * for that request: the platforms serve prerendered documents before any server code runs (Workers Static Assets,
 * Vercel's CDN), and Nitro's Node server renders them again (its public-asset table is built before Start
 * prerenders). So a prerendered page counts as `dynamic` here — a per-request nonce policy rather than the hashes
 * of a document that is not the one being sent, and no edge caching of per-request HTML — and a prerendered
 * endpoint counts as a `route`. The build manifest itself (`.hypdriv/manifest.json`, the static header rules)
 * keeps the build-time classification.
 */
export function renderedManifest(manifest: HypManifest): HypManifest {
  let changed = false;
  const routes = manifest.routes.map((route): HypRoute => {
    if (route.kind === 'endpoint' || route.kind === 'app-route' || route.kind === 'page-api') {
      if (route.classification !== 'static' && route.classification !== 'isr') return route;
      changed = true;
      return { ...route, classification: 'route' };
    }
    if (
      route.classification === 'static' ||
      route.classification === 'isr' ||
      route.classification === 'shell'
    ) {
      changed = true;
      return { ...route, classification: 'dynamic' };
    }
    return route;
  });
  return changed ? { ...manifest, routes } : manifest;
}

type Loaded = HypManifest | { default: HypManifest } | null | undefined;

function unwrap(loaded: Loaded): HypManifest | null {
  if (!loaded) return null;
  if (typeof loaded === 'object' && 'default' in loaded && !('routes' in loaded))
    return (loaded as { default: HypManifest }).default ?? null;
  return loaded as HypManifest;
}

/**
 * Wraps a manifest source (object, loader or none) so the handler receives `renderedManifest()` of it. Without a
 * source, `.hypdriv/manifest.json` is read from the working directory (Node), as `createHandler` does.
 */
export function renderedManifestSource(source: ManifestSource | undefined): ManifestSource {
  if (source === null) return null;
  if (source === undefined)
    return async () => {
      const manifest = await readManifestFile(Number.POSITIVE_INFINITY);
      return manifest ? renderedManifest(manifest) : null;
    };
  if (typeof source === 'function')
    return async () => {
      const manifest = unwrap((await source()) as Loaded);
      return manifest ? renderedManifest(manifest) : null;
    };
  return renderedManifest(source);
}

/** The same transformation for loaders that must resolve to a manifest (the Cloudflare Worker shell). */
export function renderedManifestLoader(
  source: HypManifest | (() => Promise<{ default: HypManifest } | HypManifest>) | undefined,
): HypManifest | (() => Promise<HypManifest>) | undefined {
  if (source === undefined) return undefined;
  if (typeof source === 'function')
    return async () => {
      const manifest = unwrap((await source()) as Loaded);
      if (!manifest) throw new Error('hypdriv: the manifest module resolved to nothing');
      return renderedManifest(manifest);
    };
  return renderedManifest(source);
}
