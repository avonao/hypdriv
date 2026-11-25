/**
 * Purser stylesheet analysis: a small, string-aware CSS scanner that finds the atom classes a
 * stylesheet declares. It only looks at rule preludes (selectors); declarations, at-rule preludes and
 * `@keyframes` bodies are skipped, and a class inside `:not(…)` counts as an exclusion, not a declaration
 * (Purser's globals exclude atom classes: `body:not(.xce3dr7w, .xo6613xh) { color: … }`).
 */

/** Escapes a string for use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How a project's Purser classes are named, which is what tells them apart from other classes:
 * `legacy` (the default) is the prefix plus seven base-36 characters, `short` is four characters
 * (a letter, then three of `A-Za-z0-9_-`), and `min` is the prefix (an underscore unless set) plus
 * one to four characters the build handed out in sequence (`_a`, `_b`, … `_aa`, …).
 */
export interface AtomNaming {
  prefix: string;
  names?: 'legacy' | 'short' | 'min';
  /** Name of the atoms cascade layer (default `purser.atoms`). */
  atomsLayer?: string;
}

/** A prefix alone means legacy names, as before Purser 0.2. */
export type AtomNamingInput = string | AtomNaming;

/** The naming of a resolved `purser` configuration. */
export function atomNaming(config: {
  prefix: string;
  names?: 'legacy' | 'short' | 'min';
  layers?: { atoms: string };
}): AtomNaming {
  return {
    prefix: config.prefix,
    names: config.names ?? 'legacy',
    atomsLayer: config.layers?.atoms ?? 'purser.atoms',
  };
}

function resolveNaming(input: AtomNamingInput): Required<AtomNaming> {
  const n = typeof input === 'string' ? { prefix: input } : input;
  return { prefix: n.prefix, names: n.names ?? 'legacy', atomsLayer: n.atomsLayer ?? 'purser.atoms' };
}

/** The class-name body for a naming, as RegExp source (no anchors). */
function classSource(naming: Required<AtomNaming>): string {
  if (naming.names === 'short') return '[A-Za-z][A-Za-z0-9_-]{3}';
  // Minimal names are handed out in sequence, shortest first: four characters after the prefix name seventeen
  // million classes. The bound keeps other underscore names out (a bundler's CSS-module names such as
  // `_title_1x2y3_7` are longer).
  if (naming.names === 'min')
    return naming.prefix ? `${escapeRegExp(naming.prefix)}[A-Za-z0-9_-]{1,4}` : '[A-Za-z][A-Za-z0-9_-]{0,3}';
  return `${escapeRegExp(naming.prefix)}[0-9a-z]{7}`;
}

/**
 * A pattern for one whole class name under a naming. With legacy names (`^<prefix>[0-9a-z]{7}$`) a
 * match is almost certainly a Purser class; with short or prefix-less minimal names other classes
 * match too (see {@link atomNamesAreDistinct}).
 */
export function atomClassPattern(naming: AtomNamingInput): RegExp {
  return new RegExp(`^${classSource(resolveNaming(naming))}$`);
}

/**
 * Can a class be recognised as Purser's by its name alone? Yes for legacy names and for minimal
 * names with a prefix; no for short names (any four-character class looks the same) and for
 * minimal names without a prefix. Where it cannot, only the stylesheet says which classes are atoms.
 */
export function atomNamesAreDistinct(naming: AtomNamingInput): boolean {
  const n = resolveNaming(naming);
  return n.names === 'legacy' || (n.names === 'min' && n.prefix !== '');
}

export interface StylesheetAnalysis {
  /** Classes that are the subject of at least one rule (with short or minimal names: inside the atoms layer). */
  atoms: Set<string>;
  /** Classes matching the pattern that appear only inside `:not(…)` groups. */
  exclusions: Set<string>;
  /** `@keyframes` names, in order of appearance. */
  keyframes: string[];
  /** Names in the first top-level `@layer a, b, c;` statement, or `null`. */
  layerStatement: string[] | null;
  /** Top-level `@layer name { … }` blocks, in order. */
  layerBlocks: string[];
  /** Style rules seen (selector lists count once). */
  rules: number;
  /** Conditional group rules seen (`@media`, `@supports`, `@container`, …). */
  groups: number;
}

type Frame = 'rule' | 'group' | 'keyframes' | 'declarations';

/** At-rules whose block holds declarations rather than rules. */
const DECLARATION_AT_RULES = new Set([
  'font-face',
  'page',
  'counter-style',
  'property',
  'font-feature-values',
  'font-palette-values',
  'view-transition',
  'position-try',
  'color-profile',
]);

function skipString(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote || c === '\n') return j + 1;
    j++;
  }
  return j;
}

/** Removes `/* … *\/` comments outside strings. */
export function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const end = skipString(css, i);
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function parseLayerList(prelude: string): string[] {
  return prelude
    .replace(/^@layer\b/i, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Collects prefix-matching classes from one selector list, separating `:not(…)` exclusions. */
function collectSelectorClasses(
  selector: string,
  classRe: RegExp,
  atoms: Set<string>,
  exclusions: Set<string>,
): void {
  const groups: boolean[] = [];
  let i = 0;
  while (i < selector.length) {
    const c = selector[i];
    if (c === '"' || c === "'") {
      i = skipString(selector, i);
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '(') {
      groups.push(/:not$/i.test(selector.slice(Math.max(0, i - 4), i)));
      i++;
      continue;
    }
    if (c === ')') {
      groups.pop();
      i++;
      continue;
    }
    if (c === '.') {
      classRe.lastIndex = i;
      const m = classRe.exec(selector);
      if (m) {
        (groups.includes(true) ? exclusions : atoms).add(m[1]!);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
}

/**
 * Scans a stylesheet once and reports its atoms, keyframes, layers and rule counts. With `prefix`
 * `null` only structure is reported (no class collection).
 */
export function analyzeStylesheet(css: string, prefix: AtomNamingInput | null): StylesheetAnalysis {
  const src = stripCssComments(css);
  const naming = prefix === null ? null : resolveNaming(prefix);
  const classRe = naming === null ? null : new RegExp(`\\.(${classSource(naming)})(?![A-Za-z0-9_-])`, 'y');
  // Legacy names are recognised anywhere. Short and minimal names look like other classes (`.dark`
  // is four characters), so a class only counts as an atom where atoms are: inside the atoms layer.
  const scoped = naming !== null && naming.names !== 'legacy';
  /** Layer names of the open blocks (`''` for a block that is not a layer). */
  const layerPath: string[] = [];
  const inAtomsLayer = () => layerPath.filter(Boolean).join('.') === naming?.atomsLayer;
  const result: StylesheetAnalysis = {
    atoms: new Set(),
    exclusions: new Set(),
    keyframes: [],
    layerStatement: null,
    layerBlocks: [],
    rules: 0,
    groups: 0,
  };
  const stack: Frame[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i]!;
    if (ch === '}') {
      stack.pop();
      layerPath.pop();
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f') {
      i++;
      continue;
    }
    const start = i;
    let parens = 0;
    let brackets = 0;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'") {
        i = skipString(src, i);
        continue;
      }
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '(') parens++;
      else if (c === ')') parens = Math.max(0, parens - 1);
      else if (c === '[') brackets++;
      else if (c === ']') brackets = Math.max(0, brackets - 1);
      else if (parens === 0 && brackets === 0 && (c === '{' || c === ';' || c === '}')) break;
      i++;
    }
    const text = src.slice(start, i).trim();
    if (i >= n) break;
    const terminator = src[i];
    if (terminator === '{') {
      i++;
      const parent = stack[stack.length - 1];
      if (text.startsWith('@')) {
        const m = /^@([A-Za-z-]+)\s*([\s\S]*)$/.exec(text);
        const name = (m?.[1] ?? '').toLowerCase();
        const rest = (m?.[2] ?? '').trim();
        if (name === 'keyframes' || name.endsWith('-keyframes')) {
          if (rest) result.keyframes.push(rest.replace(/^["']|["']$/g, ''));
          stack.push('keyframes');
          layerPath.push('');
        } else if (DECLARATION_AT_RULES.has(name)) {
          stack.push('declarations');
          layerPath.push('');
        } else {
          if (name === 'layer' && stack.length === 0 && rest) result.layerBlocks.push(rest);
          if (name !== 'layer') result.groups++;
          stack.push('group');
          layerPath.push(name === 'layer' ? rest : '');
        }
      } else if (parent === 'keyframes' || parent === 'declarations') {
        stack.push('declarations');
        layerPath.push('');
      } else {
        result.rules++;
        if (classRe) {
          if (!scoped || inAtomsLayer())
            collectSelectorClasses(text, classRe, result.atoms, result.exclusions);
          // outside the atoms layer only the exclusions of globals are of interest: `body:not(._a, ._b)`
          else collectSelectorClasses(text, classRe, new Set(), result.exclusions);
        }
        stack.push('rule');
        layerPath.push('');
      }
    } else if (terminator === ';') {
      i++;
      if (result.layerStatement === null && stack.length === 0 && /^@layer\b/i.test(text)) {
        result.layerStatement = parseLayerList(text);
      }
    }
    // A '}' terminator (declaration without a trailing semicolon) is handled by the next iteration.
  }
  return result;
}

/**
 * Every atom class a Purser stylesheet declares: `.<prefix>XXXXXXX` selectors where the class is a
 * subject (not inside `:not(…)`), inside any nesting of `@layer`, `@media`, `@supports` and
 * `@container`. Keyframes names and declarations are ignored.
 */
export function extractAtomClasses(css: string, prefix: AtomNamingInput): Set<string> {
  return analyzeStylesheet(css, prefix).atoms;
}

/** Names from the first top-level `@layer a, b, c;` statement, or `null` when there is none. */
export function extractLayerStatement(css: string): string[] | null {
  return analyzeStylesheet(css, null).layerStatement;
}

/**
 * `true` when the text looks like a Purser stylesheet: it opens with a three-name `@layer` statement
 * (matching `layers` when given) or carries Purser's banner. Works on minified output too.
 */
export function isPurserStylesheet(
  css: string,
  layers?: { tokens: string; globals: string; atoms: string },
): boolean {
  if (/^\s*\/\*\s*Generated by purser\b/i.test(css)) return true;
  const statement = extractLayerStatement(css);
  if (statement?.length === 3) {
    if (!layers) return true;
    const [tokens, globals, atoms] = statement;
    if (tokens === layers.tokens && globals === layers.globals && atoms === layers.atoms) return true;
  }
  // Bundlers (Next.js/Turbopack via Lightning CSS) drop the comment and fold the ordering statement into
  // the layer blocks, so fall back to the tokens and atoms layer blocks themselves.
  const names = layers ?? { tokens: 'purser.tokens', globals: 'purser.globals', atoms: 'purser.atoms' };
  const block = (name: string) =>
    new RegExp(`@layer\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`);
  return block(names.tokens).test(css) && block(names.atoms).test(css);
}
