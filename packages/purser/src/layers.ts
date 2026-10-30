import { HypDrivError } from '@hypdriv/core';

/** A CSS cascade layer name, optionally dotted for sub-layers (`purser.atoms`). Mirrors Purser's check. */
export const LAYER_NAME_RE = /^-?[A-Za-z_][\w-]*(?:\.-?[A-Za-z_][\w-]*)*$/;

/** Purser's default layer names. */
export const DEFAULT_PURSER_LAYERS = Object.freeze({
  tokens: 'purser.tokens',
  globals: 'purser.globals',
  atoms: 'purser.atoms',
});

export interface LayerStatementOptions {
  /** Purser's three layer names (`config.purser.layers`). */
  layers: { tokens: string; globals: string; atoms: string };
  /** Layers that sit beneath everything Purser emits (rare: a third-party reset Purser's globals must beat). */
  before?: string[];
  /**
   * Existing layers that must beat Purser's globals but lose to its atoms: Tailwind's
   * (`theme, base, components, utilities`), a `legacy` layer wrapping unlayered rules, and so on.
   */
  after?: string[];
}

/**
 * Builds the single `@layer` statement that orders Purser among existing layers, following Purser's
 * "Adopting Purser next to existing CSS" guide: tokens and globals go below the existing layers, atoms
 * above them. `{ layers, before: ['a', 'b'], after: ['c'] }` yields
 * `@layer a, b, purser.tokens, purser.globals, c, purser.atoms;`. Put it at the very top of the first
 * stylesheet the page loads (a `@layer` statement may precede `@import`).
 *
 * @throws HypDrivError `E_CONFIG` for invalid or duplicate layer names, and when `after` is used
 * with dotted Purser names that share a parent: `purser.atoms` cannot sit above `c` once `purser`
 * was declared below it, so top-level names (`purser-tokens, purser-globals, purser-atoms`) are required.
 */
export function layerStatement(options: LayerStatementOptions): string {
  const before = options.before ?? [];
  const after = options.after ?? [];
  const purser = [options.layers.tokens, options.layers.globals, options.layers.atoms];
  const order = [...before, options.layers.tokens, options.layers.globals, ...after, options.layers.atoms];
  const seen = new Set<string>();
  for (const name of order) {
    if (typeof name !== 'string' || !LAYER_NAME_RE.test(name))
      throw new HypDrivError('E_CONFIG', `layerStatement: ${JSON.stringify(name)} is not a CSS layer name`);
    if (seen.has(name)) throw new HypDrivError('E_CONFIG', `layerStatement: layer "${name}" is listed twice`);
    seen.add(name);
  }
  if (after.length) {
    const parent = (name: string) => (name.includes('.') ? name.split('.')[0] : null);
    const atomsParent = parent(options.layers.atoms);
    if (atomsParent && purser.slice(0, 2).some((n) => parent(n) === atomsParent)) {
      throw new HypDrivError(
        'E_CONFIG',
        `layerStatement: "${options.layers.atoms}" shares the parent layer "${atomsParent}" with the tokens/globals layers, so it cannot be ordered above ${after.join(', ')}. Give Purser top-level layer names (purser.layers: { tokens: 'purser-tokens', globals: 'purser-globals', atoms: 'purser-atoms' }).`,
      );
    }
  }
  return `@layer ${order.join(', ')};`;
}
