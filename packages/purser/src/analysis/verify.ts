import { extractHtmlClasses } from './html';
import { extractAtomClasses } from './stylesheet';

export interface VerifyAtomsInput {
  /** Route id (or pathname) → prerendered HTML / RSC payload text. */
  html: Record<string, string>;
  /** The generated Purser stylesheet. */
  css: string;
  /** Class prefix (`config.purser.prefix`, default `x`). */
  prefix: string;
}

export interface VerifyAtomsResult {
  /** Route → classes referenced by the document but absent from the stylesheet. Only routes with problems. */
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
  prefix: string,
): VerifyAtomsResult {
  const missing: Record<string, string[]> = {};
  const used: Record<string, string[]> = {};
  const referenced = new Set<string>();
  for (const route of Object.keys(html).sort()) {
    const classes = extractHtmlClasses(html[route] ?? '', prefix);
    const routeUsed: string[] = [];
    const routeMissing: string[] = [];
    for (const cls of classes) {
      referenced.add(cls);
      if (declared.has(cls)) routeUsed.push(cls);
      else routeMissing.push(cls);
    }
    used[route] = routeUsed.sort();
    if (routeMissing.length) missing[route] = routeMissing.sort();
  }
  const unused = [...declared].filter((cls) => !referenced.has(cls)).sort();
  return { missing, used, unused };
}
