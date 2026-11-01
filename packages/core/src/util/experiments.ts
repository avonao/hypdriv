/**
 * The experiment cookie: each visitor's variants, kept sticky across weight changes and read by the vitals
 * beacon route to slice measurements by variant.
 *
 * `checkout:b.hero:control*` — `name:variant` pairs joined by `.`; a trailing `*` marks the visitor as exposed
 * (counted once). Names and variants are URL-safe tokens, so the value needs no encoding.
 */

/** A visitor's variant in one experiment. */
export interface ExperimentMembership {
  variant: string;
  /** The visitor has been counted as exposed to the experiment. */
  exposed: boolean;
}

const TOKEN = /^[A-Za-z0-9_-]{1,48}$/;
const MAX_ENTRIES = 24;
const MAX_LENGTH = 1800;

/** Reads the cookie value; malformed entries are dropped. */
export function parseExperimentCookie(
  value: string | null | undefined,
): Record<string, ExperimentMembership> {
  const out: Record<string, ExperimentMembership> = {};
  if (!value || value.length > 4096) return out;
  for (const entry of value.split('.')) {
    const exposed = entry.endsWith('*');
    const [name, variant, extra] = (exposed ? entry.slice(0, -1) : entry).split(':');
    if (extra !== undefined || !name || !variant || !TOKEN.test(name) || !TOKEN.test(variant)) continue;
    if (Object.hasOwn(out, name)) continue;
    out[name] = { variant, exposed };
    if (Object.keys(out).length >= MAX_ENTRIES) break;
  }
  return out;
}

/** Writes the cookie value (sorted, bounded). Empty when there is nothing to remember. */
export function serializeExperimentCookie(memberships: Record<string, ExperimentMembership>): string {
  let out = '';
  for (const name of Object.keys(memberships).sort().slice(0, MAX_ENTRIES)) {
    const m = memberships[name];
    if (!m || !TOKEN.test(name) || !TOKEN.test(m.variant)) continue;
    const entry = `${name}:${m.variant}${m.exposed ? '*' : ''}`;
    if (out.length + entry.length + 1 > MAX_LENGTH) break;
    out += out ? `.${entry}` : entry;
  }
  return out;
}

/**
 * The tag the vitals sink stores next to a measurement: `|checkout:b|hero:control|`. The delimiters on both ends
 * make `LIKE '%|checkout:b|%'` an exact match for one experiment and variant.
 */
export function experimentTag(memberships: Record<string, ExperimentMembership>): string {
  const pairs = Object.keys(memberships)
    .sort()
    .map((name) => `${name}:${memberships[name]?.variant}`);
  return pairs.length ? `|${pairs.join('|')}|` : '';
}

/** Reads the variant of one experiment out of an {@link experimentTag}. */
export function variantFromTag(tag: string | null | undefined, experiment: string): string | undefined {
  if (!tag) return undefined;
  const prefix = `|${experiment}:`;
  const start = tag.indexOf(prefix);
  if (start === -1) return undefined;
  const from = start + prefix.length;
  const end = tag.indexOf('|', from);
  return tag.slice(from, end === -1 ? undefined : end) || undefined;
}

/**
 * The control variant of an experiment: the flag's `default` when it names one of the variants (validation
 * requires that), else the first variant.
 */
export function experimentControl(
  def: { default: unknown },
  spec: { variants: Record<string, number> },
): string {
  return typeof def.default === 'string' && Object.hasOwn(spec.variants, def.default)
    ? def.default
    : (Object.keys(spec.variants)[0] ?? String(def.default));
}

/**
 * The flag names of the experiments that still assign variants (everything but `concluded`). Edge cache policies
 * vary on these, so each variant is cached — and served — separately.
 */
export function runningExperiments(
  definitions: Record<string, { experiment?: { status?: string } | undefined }>,
): string[] {
  return Object.entries(definitions)
    .filter(([, def]) => def.experiment && (def.experiment.status ?? 'running') !== 'concluded')
    .map(([name]) => name)
    .sort();
}
