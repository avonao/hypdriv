import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { buildManifest, collectDocuments } from './build-manifest';
import { classifyOutputs } from './classify';
import { createNodeFs, rerootPaths } from './fs';
import type { OnBuildCompleteContext } from './types';

// Captured from examples/with-purser (Next.js 16.4.3, Turbopack, cacheComponents + partialPrefetching,
// deploymentId set, Purser stylesheet).
const fixtureDir = fileURLToPath(
  new URL('./__fixtures__/next-16.4-cache-components/', import.meta.url),
).replace(/\/$/, '');
const context = rerootPaths(
  JSON.parse(readFileSync(join(fixtureDir, 'onBuildComplete.json'), 'utf8')) as OnBuildCompleteContext,
  fixtureDir,
);
const fs = createNodeFs();

describe('Cache Components build (Next 16.4)', () => {
  it('does not treat renderingMode PARTIALLY_STATIC as a shell', () => {
    const classes = Object.fromEntries(
      classifyOutputs(context.outputs, '.rsc').map((c) => [c.route.pathname, c.route.classification]),
    );
    expect(classes['/']).toBe('static');
    expect(classes['/docs/[slug]']).toBe('isr');
  });

  it('collects every prerendered document with its RSC payload from the route-cache layout', () => {
    const documents = collectDocuments(context, fs);
    expect(Object.keys(documents)).toEqual(
      expect.arrayContaining(['/', '/docs/audit', '/docs/guard', '/docs/themes']),
    );
    expect(documents['/']).toContain('<html');
    // RSC payload appended after the HTML
    expect(documents['/']!.split('\n').length).toBeGreaterThan(1);
    expect(Object.keys(documents).some((k) => k.includes('.segments'))).toBe(false);
  });

  it('builds a manifest with hash CSP for the static home page and component inline-script hashes', async () => {
    const config = resolveConfig({
      purser: {
        enabled: true,
        theme: { axes: { mode: { classes: { light: null, dark: 'dark' }, default: 'light' } } },
      },
      performance: { speculation: { prerender: { eagerness: 'moderate' } } },
    });
    const { manifest, failures } = await buildManifest({
      context,
      config,
      fs,
      hypdrivVersion: '0.0.0-test',
      now: () => new Date(0),
    });
    expect(failures).toEqual([]);
    const home = manifest.routes.find((r) => r.id === 'app:/');
    expect(home?.classification).toBe('static');
    expect(manifest.csp['app:/']?.scriptHashes.length).toBeGreaterThan(0);
    expect(manifest.inlineScriptHashes?.length).toBe(1);
    expect(manifest.deploymentId).toBeTruthy();
    // assets are listed once, with the document's ?dpl= spelling
    const css = home?.assets.css ?? [];
    expect(css.every((href) => href.includes('?dpl='))).toBe(true);
    expect(new Set(css.map((h) => h.split('?')[0])).size).toBe(css.length);
    expect(
      (manifest.earlyHints['app:/'] ?? []).every((link) => !link.includes('.js>') || link.includes('?dpl=')),
    ).toBe(true);
    // the internal error boundary is not budgeted
    expect(manifest.budgets?.some((b) => b.target === '/_global-error')).toBe(false);
  });
});
