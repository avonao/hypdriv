import { extractHtmlClasses } from './html';
import { type AtomNamingInput, atomNamesAreDistinct, extractAtomClasses } from './stylesheet';

export interface VerifyAtomsInput {
  /** Route id (or pathname) → prerendered HTML / RSC payload text. */
  html: Record<string, string>;
  /** The generated Purser stylesheet. */
  css: string;
  /** Class prefix (`config.purser.prefix`, default `x`), or the whole naming (prefix, names, atoms layer). */
  prefix: AtomNamingInput;
}

export interface VerifyAtomsResult {
  /**
   * Route → classes referenced by the document but absent from the stylesheet. Only routes with problems.
   * Always empty when Purser's classes cannot be told from other classes by name (short names, minimal
   * names without a prefix): a class the stylesheet lacks could be anyone's.
   */
  missing: Record<string, string[]>;
  /** Route → declared atoms the document references (sorted). Every input route is present. */
  used: Record<string, string[]>;
  /** Declared atoms no input document references (sorted). */
  unused: string[];
}

/**
 * The unstyled-atom guard. Compares the atoms a stylesheet declares with the Purser classes every
 * prerendered document references, per route. Also the atom usage report: `used` per route and the
 * `unused` (dead) atoms across all routes.
 */
export function verifyAtoms(input: VerifyAtomsInput): VerifyAtomsResult {
  return verifyAtomsAgainst(extractAtomClasses(input.css, input.prefix), input.html, input.prefix);
}

/** {@link verifyAtoms} with the stylesheet already analysed. */
export function verifyAtomsAgainst(
  declared: ReadonlySet<string>,
  html: Record<string, string>,
  prefix: AtomNamingInput,
): VerifyAtomsResult {
  const missing: Record<string, string[]> = {};
  const used: Record<string, string[]> = {};
  const referenced = new Set<string>();
  const distinct = atomNamesAreDistinct(prefix);
  for (const route of Object.keys(html).sort()) {
    const classes = extractHtmlClasses(html[route] ?? '', prefix);
    const routeUsed: string[] = [];
    const routeMissing: string[] = [];
    for (const cls of classes) {
      referenced.add(cls);
      if (declared.has(cls)) routeUsed.push(cls);
      else if (distinct) routeMissing.push(cls);
    }
    used[route] = routeUsed.sort();
    if (routeMissing.length) missing[route] = routeMissing.sort();
  }
  const unused = [...declared].filter((cls) => !referenced.has(cls)).sort();
  return { missing, used, unused };
}
