import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
  exports: Record<string, string | { source: string; types: string; default: string }>;
  bin: Record<string, string>;
};

describe('hypdriv umbrella', () => {
  it('exposes the documented entry points', async () => {
    const root = await import('./index');
    expect(typeof root.defineConfig).toBe('function');
    expect(typeof root.loadConfig).toBe('function');

    const config = await import('./config');
    expect(typeof config.withHypDriv).toBe('function');
    expect(typeof config.defineConfig).toBe('function');

    const proxy = await import('./proxy');
    expect(typeof proxy.createProxy).toBe('function');
    expect(proxy.matcher.matcher.length).toBeGreaterThan(0);

    const vercel = await import('./vercel');
    expect(typeof vercel.withVercelCdn).toBe('function');
    expect(typeof vercel.vercelPlatformOverrides).toBe('function');
    expect(typeof vercel.registerVercelSdk).toBe('function');
    const cloudflare = await import('./cloudflare');
    expect(typeof cloudflare.createWorker).toBe('function');
    expect(typeof cloudflare.enqueue).toBe('function');

    const server = await import('./server');
    for (const name of [
      'hyp',
      'flag',
      'nonce',
      'jobHandler',
      'safeAction',
      'defineRoute',
      'createSessionStore',
      'signJwt',
      'verifyJwt',
      'hashPassword',
      'safeRedirect',
      'enqueue',
      'publish',
    ]) {
      expect(typeof (server as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(typeof server.webhooks.verifyStripe).toBe('function');

    const cache = await import('./cache');
    expect(typeof cache.revalidateTag).toBe('function');

    const instrumentation = await import('./instrumentation');
    expect(typeof instrumentation.createInstrumentation).toBe('function');

    for (const [file, name] of [
      ['./security', 'cspStage'],
      ['./flags', 'evaluateFlags'],
      ['./live', 'publish'],
      ['./observe', 'createTracer'],
      ['./image', 'cloudflareLoader'],
      ['./purser', 'themeStage'],
    ] as const) {
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
      expect(typeof mod[name], `${file} → ${name}`).toBe('function');
    }
  });

  it('keeps package.json exports, tsdown entries and sources in sync', () => {
    const tsdown = readFileSync(join(import.meta.dirname, '..', 'tsdown.config.ts'), 'utf8');
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === 'string') continue;
      const name = subpath === '.' ? 'index' : subpath.slice(2);
      expect(target.default).toBe(`./dist/${name}.js`);
      expect(target.types).toBe(`./dist/${name}.d.ts`);
      expect(tsdown).toContain(target.source.replace('./', ''));
      expect(() => readFileSync(join(import.meta.dirname, '..', target.source))).not.toThrow();
    }
    expect(pkg.bin.hypdriv).toBe('./bin/hypdriv.js');
  });
});
