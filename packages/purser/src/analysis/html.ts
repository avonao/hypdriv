import { type AtomNamingInput, atomClassPattern } from './stylesheet';

/** `class="…"`, `class='…'` and unquoted `class=…` attributes. */
const CLASS_ATTR_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/**
 * `"className":"…"` props in RSC payloads, both in `.rsc` files (plain JSON) and as embedded in
 * prerendered HTML inside `self.__next_f.push([1,"…"])` where quotes are escaped (`\"className\":\"…\"`).
 * Class lists never contain quotes or backslashes, so the value stops at the first one.
 */
const CLASSNAME_PROP_RE = /\\?"className\\?"\s*:\s*\\?"([^"\\]*)/g;

/**
 * Every Purser class referenced by a document: tokens of `class` attributes and of `className`
 * strings in RSC payloads (embedded or standalone `.rsc` files) that match the naming's pattern
 * (`<prefix>[0-9a-z]{7}` for legacy names). A non-Purser class that happens to match the pattern is
 * reported too; choose a distinctive `purser.prefix` when other class names collide with it. With
 * short names, or minimal names without a prefix, every class of that shape matches: use the result
 * only together with the stylesheet's atoms (`verifyAtomsAgainst` does).
 */
export function extractHtmlClasses(html: string, prefix: AtomNamingInput): Set<string> {
  const out = new Set<string>();
  const pattern = atomClassPattern(prefix);
  const add = (list: string) => {
    for (const token of list.split(/\s+/)) if (token && pattern.test(token)) out.add(token);
  };
  for (const m of html.matchAll(CLASS_ATTR_RE)) add(m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of html.matchAll(CLASSNAME_PROP_RE)) add(m[1] ?? '');
  return out;
}
