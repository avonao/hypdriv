import { HypDrivError } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PURSER_LAYERS, layerStatement } from './layers';

const top = { tokens: 'purser-tokens', globals: 'purser-globals', atoms: 'purser-atoms' };

describe('layerStatement', () => {
  it('orders before, tokens, globals, after, atoms', () => {
    expect(layerStatement({ layers: top, before: ['a', 'b'], after: ['c'] })).toBe(
      '@layer a, b, purser-tokens, purser-globals, c, purser-atoms;',
    );
    expect(
      layerStatement({ layers: top, after: ['theme', 'base', 'components', 'utilities', 'legacy'] }),
    ).toBe('@layer purser-tokens, purser-globals, theme, base, components, utilities, legacy, purser-atoms;');
    expect(layerStatement({ layers: DEFAULT_PURSER_LAYERS })).toBe(
      '@layer purser.tokens, purser.globals, purser.atoms;',
    );
    expect(layerStatement({ layers: DEFAULT_PURSER_LAYERS, before: ['reset'] })).toBe(
      '@layer reset, purser.tokens, purser.globals, purser.atoms;',
    );
  });

  it('rejects invalid and duplicate names', () => {
    expect(() => layerStatement({ layers: top, after: ['1bad'] })).toThrow(HypDrivError);
    expect(() => layerStatement({ layers: top, after: ['a b'] })).toThrow(/not a CSS layer name/);
    expect(() => layerStatement({ layers: top, before: ['x'], after: ['x'] })).toThrow(/listed twice/);
    expect(() => layerStatement({ layers: { ...top, atoms: 'purser-tokens' } })).toThrow(/listed twice/);
  });

  it('refuses sub-layer names that cannot be ordered around existing layers', () => {
    expect(() => layerStatement({ layers: DEFAULT_PURSER_LAYERS, after: ['legacy'] })).toThrow(
      /top-level layer names/,
    );
    expect(
      layerStatement({
        layers: { tokens: 'p.tokens', globals: 'p.globals', atoms: 'atoms' },
        after: ['legacy'],
      }),
    ).toBe('@layer p.tokens, p.globals, legacy, atoms;');
  });
});
