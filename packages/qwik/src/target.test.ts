import { describe, expect, it } from 'vitest';
import {
  ADAPTER_MODULES,
  detectTarget,
  ENTRY_NAMES,
  isAdapterPlugin,
  resolveTarget,
  targetOfAdapter,
} from './target';

describe('detectTarget', () => {
  it('prefers HYPDRIV_TARGET, then the platform build environment, then Node', () => {
    expect(detectTarget({ HYPDRIV_TARGET: 'cloudflare', VERCEL: '1' })).toBe('cloudflare');
    expect(detectTarget({ VERCEL: '1' })).toBe('vercel');
    expect(detectTarget({ CLOUDFLARE: '1' })).toBe('cloudflare');
    expect(detectTarget({ WORKERS_CI: '1' })).toBe('cloudflare');
    expect(detectTarget({})).toBe('node');
  });

  it('ignores unknown and disabled values', () => {
    expect(detectTarget({ HYPDRIV_TARGET: 'deno' })).toBe('node');
    expect(detectTarget({ VERCEL: '0' })).toBe('node');
    expect(detectTarget({ CLOUDFLARE: 'false' })).toBe('node');
  });

  it('has no runtime for Netlify unless the target is named', () => {
    expect(detectTarget({ NETLIFY: 'true' })).toBeNull();
    expect(detectTarget({ NETLIFY: 'true', HYPDRIV_TARGET: 'node' })).toBe('node');
  });
});

describe('targetOfAdapter', () => {
  it('maps Hypdriv adapters and the Qwik adapters of the same platforms', () => {
    expect(targetOfAdapter('vite-plugin-qwik-router-ssg-hypdriv-cloudflare')).toBe('cloudflare');
    expect(targetOfAdapter('vite-plugin-qwik-router-ssg-hypdriv-vercel')).toBe('vercel');
    expect(targetOfAdapter('vite-plugin-qwik-router-ssg-hypdriv-node')).toBe('node');
    expect(targetOfAdapter('vite-plugin-qwik-router-ssg-cloudflare-pages')).toBe('cloudflare');
    expect(targetOfAdapter('vite-plugin-qwik-router-ssg-vercel-edge')).toBe('vercel');
    expect(targetOfAdapter('vite-plugin-qwik-router-ssg-node-server')).toBe('node');
  });

  it('knows nothing about other adapters or other plugins', () => {
    expect(targetOfAdapter('vite-plugin-qwik-router-ssg-netlify-edge')).toBeUndefined();
    expect(targetOfAdapter('vite-plugin-qwik-router-ssg-aws-lambda')).toBeUndefined();
    expect(targetOfAdapter('vite-plugin-qwik-router')).toBeUndefined();
  });
});

describe('isAdapterPlugin', () => {
  it('recognises the plugin of the server build by its prefix', () => {
    expect(isAdapterPlugin('vite-plugin-qwik-router-ssg-hypdriv-node')).toBe(true);
    expect(isAdapterPlugin('vite-plugin-qwik-router')).toBe(false);
    expect(isAdapterPlugin('vite-plugin-qwik')).toBe(false);
  });
});

describe('resolveTarget', () => {
  it('orders the option, the adapter that builds the server and the environment', () => {
    expect(
      resolveTarget({
        option: 'vercel',
        adapter: 'vite-plugin-qwik-router-ssg-hypdriv-node',
        env: { HYPDRIV_TARGET: 'cloudflare' },
      }),
    ).toBe('vercel');
    expect(
      resolveTarget({
        adapter: 'vite-plugin-qwik-router-ssg-hypdriv-node',
        env: { HYPDRIV_TARGET: 'cloudflare' },
      }),
    ).toBe('node');
    expect(resolveTarget({ env: { HYPDRIV_TARGET: 'cloudflare' } })).toBe('cloudflare');
    expect(resolveTarget({ adapter: 'vite-plugin-qwik-router-ssg-netlify-edge', env: { VERCEL: '1' } })).toBe(
      'vercel',
    );
    expect(resolveTarget({ env: {} })).toBe('node');
    expect(resolveTarget({ env: { NETLIFY: 'true' } })).toBe('node');
  });
});

describe('adapter and entry tables', () => {
  it('names one Hypdriv adapter and one server entry per target', () => {
    expect(ADAPTER_MODULES).toEqual({
      cloudflare: '@hypdriv/qwik/adapters/cloudflare',
      vercel: '@hypdriv/qwik/adapters/vercel',
      node: '@hypdriv/qwik/adapters/node',
    });
    expect(ENTRY_NAMES).toEqual({
      cloudflare: 'entry.cloudflare',
      vercel: 'entry.vercel',
      node: 'entry.node',
    });
  });
});
