import type { StaticHeaderRule } from '@hypdriv/build';
import { describe, expect, it } from 'vitest';
import { nodeRouteRules, targetForNitroPreset } from './target';

describe('targetForNitroPreset', () => {
  it('maps Nitro presets to Hypdriv targets', () => {
    expect(targetForNitroPreset('vercel')).toBe('vercel');
    expect(targetForNitroPreset('vercel-edge')).toBe('vercel');
    expect(targetForNitroPreset('cloudflare_module')).toBe('cloudflare');
    expect(targetForNitroPreset('cloudflare-pages')).toBe('cloudflare');
    expect(targetForNitroPreset('node-server')).toBe('node');
    expect(targetForNitroPreset('node_server')).toBe('node');
    expect(targetForNitroPreset('bun')).toBe('node');
    expect(targetForNitroPreset(undefined)).toBe('node');
    expect(targetForNitroPreset('')).toBe('node');
  });
});

describe('nodeRouteRules', () => {
  const rules: StaticHeaderRule[] = [
    { path: '/*', set: { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' } },
    { path: '/_build/assets/*', set: { 'cache-control': 'public, max-age=31536000, immutable' } },
    { path: '/about', set: { 'content-security-policy': "default-src 'self'" } },
  ];

  it('turns prefix rules into Nitro route rules that include the catch-all headers', () => {
    expect(nodeRouteRules(rules)).toEqual({
      '/_build/assets/**': {
        headers: {
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      },
    });
  });

  it('leaves document and catch-all rules to the pipeline', () => {
    expect(nodeRouteRules([rules[0] as StaticHeaderRule, rules[2] as StaticHeaderRule])).toEqual({});
    expect(nodeRouteRules([])).toEqual({});
  });
});
