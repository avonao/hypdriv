import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundledModules, escapeRegExp, runtimePackages, withExternal } from './nitro-config';

describe('withExternal', () => {
  const cloudflare = /^cloudflare:/;

  it('appends to a missing, single or array option', () => {
    expect(withExternal(undefined, cloudflare)).toEqual([cloudflare]);
    expect(withExternal('fsevents', cloudflare)).toEqual(['fsevents', cloudflare]);
    expect(withExternal(['a', /b/], cloudflare)).toEqual(['a', /b/, cloudflare]);
  });

  it('wraps a function option', () => {
    const external = withExternal((id) => id === 'own', cloudflare) as (
      id: string,
      importer: string | undefined,
      isResolved: boolean,
    ) => boolean;
    expect(external('cloudflare:workers', undefined, false)).toBe(true);
    expect(external('own', undefined, false)).toBe(true);
    expect(external('other', undefined, false)).toBe(false);
  });
});

describe('bundledModules', () => {
  it('bundles the runtime directory and every @hypdriv package, including the workspace directory that holds them', () => {
    expect(bundledModules('/repo/packages/nitro/dist')).toEqual([
      '/repo/packages/nitro/dist',
      '@hypdriv/',
      '/repo/packages/',
    ]);
    expect(bundledModules('/repo/packages/nitro/src')).toContain('/repo/packages/');
  });

  it('adds the scope directory of an installed package', () => {
    expect(bundledModules('/app/node_modules/@hypdriv/nitro/dist')).toEqual([
      '/app/node_modules/@hypdriv/nitro/dist',
      '@hypdriv/',
      '/app/node_modules/@hypdriv/',
    ]);
  });

  it('does not widen the match for other layouts', () => {
    expect(bundledModules('/opt/vendor/hypdriv-nitro/dist')).toEqual([
      '/opt/vendor/hypdriv-nitro/dist',
      '@hypdriv/',
    ]);
  });
});

describe('runtimePackages', () => {
  it('resolves the Hypdriv packages the server runtime imports to files on disk', () => {
    const packages = runtimePackages(import.meta.url);
    expect(Object.keys(packages).sort()).toEqual(['@hypdriv/core', '@hypdriv/flags', '@hypdriv/runtime']);
    for (const file of Object.values(packages)) expect(existsSync(file)).toBe(true);
  });
});

describe('escapeRegExp', () => {
  it('matches the literal path', () => {
    const dir = '/home/u/.pnpm/@hypdriv+nuxt@1.0.0(vite@8)/dist';
    expect(new RegExp(`^${escapeRegExp(dir)}`).test(`${dir}/runtime/x.js`)).toBe(true);
    expect(new RegExp(`^${escapeRegExp(dir)}`).test('/home/u/.pnpm/@hypdriv+nuxtX1.0.0(vite@8)/dist')).toBe(
      false,
    );
  });
});
