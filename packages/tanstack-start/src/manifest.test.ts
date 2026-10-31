import { emptyManifest, type HypManifest, type HypRoute, routePatternToRegex } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { renderedManifest, renderedManifestLoader, renderedManifestSource } from './manifest';

const route = (
  id: string,
  kind: HypRoute['kind'],
  classification: HypRoute['classification'],
  pathname = id.split(':')[1]!,
): HypRoute => ({
  id,
  pathname,
  regex: routePatternToRegex(pathname),
  kind,
  classification,
  runtime: 'nodejs',
  dynamic: pathname.includes('['),
  assets: { js: [], css: [], fonts: [] },
});

const manifest: HypManifest = emptyManifest({
  buildId: 'b',
  routes: [
    route('page:/', 'page', 'static'),
    route('page:/news', 'page', 'isr'),
    route('page:/account', 'page', 'dynamic'),
    route('endpoint:/feed.xml', 'endpoint', 'static'),
    route('endpoint:/api/x', 'endpoint', 'route'),
  ],
  csp: { 'page:/': { scriptHashes: ["'sha256-x'"], styleHashes: [] } },
});

describe('renderedManifest', () => {
  it('treats every page that reaches the renderer as rendered for the request', () => {
    const view = renderedManifest(manifest);
    expect(view.routes.map((r) => [r.id, r.classification])).toEqual([
      ['page:/', 'dynamic'],
      ['page:/news', 'dynamic'],
      ['page:/account', 'dynamic'],
      ['endpoint:/feed.xml', 'route'],
      ['endpoint:/api/x', 'route'],
    ]);
    // The build manifest itself is untouched; everything else is kept.
    expect(manifest.routes[0]!.classification).toBe('static');
    expect(view.csp).toBe(manifest.csp);
    expect(view.buildId).toBe('b');
  });

  it('returns the same object when nothing changes', () => {
    const dynamicOnly = emptyManifest({ routes: [route('page:/a', 'page', 'dynamic')] });
    expect(renderedManifest(dynamicOnly)).toBe(dynamicOnly);
  });

  it('wraps objects, loaders and module namespaces', async () => {
    expect((renderedManifestSource(manifest) as HypManifest).routes[0]!.classification).toBe('dynamic');
    expect(renderedManifestSource(null)).toBeNull();
    const loader = renderedManifestSource(async () => ({ default: manifest })) as () => Promise<HypManifest>;
    expect((await loader()).routes[0]!.classification).toBe('dynamic');
    const shell = renderedManifestLoader(async () => ({ default: manifest })) as () => Promise<HypManifest>;
    expect((await shell()).routes[1]!.classification).toBe('dynamic');
    expect(renderedManifestLoader(undefined)).toBeUndefined();
    await expect(
      (renderedManifestLoader(async () => null as never) as () => Promise<HypManifest>)(),
    ).rejects.toThrow();
  });
});
