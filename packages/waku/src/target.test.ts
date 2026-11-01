import { describe, expect, it } from 'vitest';
import { ADAPTER_MODULES, detectTarget, resolveTarget } from './target';

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

  it('picks Cloudflare for a build with @cloudflare/vite-plugin, after HYPDRIV_TARGET', () => {
    expect(detectTarget({}, { cloudflarePlugin: true })).toBe('cloudflare');
    expect(detectTarget({ VERCEL: '1' }, { cloudflarePlugin: true })).toBe('cloudflare');
    expect(detectTarget({ HYPDRIV_TARGET: 'node' }, { cloudflarePlugin: true })).toBe('node');
    expect(detectTarget({}, { cloudflarePlugin: false })).toBe('node');
  });

  it('leaves Netlify to Waku', () => {
    expect(detectTarget({ NETLIFY: 'true' })).toBeNull();
    expect(detectTarget({ NETLIFY: 'true', HYPDRIV_TARGET: 'node' })).toBe('node');
  });
});

describe('resolveTarget', () => {
  it('orders the option, HYPDRIV_TARGET, the Cloudflare plugin and the environment', () => {
    expect(resolveTarget({ option: 'vercel', cloudflarePlugin: true, env: { HYPDRIV_TARGET: 'node' } })).toBe(
      'vercel',
    );
    expect(resolveTarget({ cloudflarePlugin: true, env: { HYPDRIV_TARGET: 'node' } })).toBe('node');
    expect(resolveTarget({ cloudflarePlugin: true, env: { VERCEL: '1' } })).toBe('cloudflare');
    expect(resolveTarget({ env: { VERCEL: '1' } })).toBe('vercel');
    expect(resolveTarget({ env: {} })).toBe('node');
    expect(resolveTarget({ env: { NETLIFY: 'true' } })).toBe('node');
  });
});

describe('ADAPTER_MODULES', () => {
  it('names one Hypdriv adapter per target', () => {
    expect(ADAPTER_MODULES).toEqual({
      cloudflare: '@hypdriv/waku/adapters/cloudflare',
      vercel: '@hypdriv/waku/adapters/vercel',
      node: '@hypdriv/waku/adapters/node',
    });
  });
});
