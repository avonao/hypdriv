import { shortHash } from './hash';

/**
 * The experiment cookie: each visitor's variants, kept sticky across weight changes and read by the vitals
 * beacon route to slice measurements by variant.
 *
 * `checkout:b~k3x.hero:control*` — `name:variant` pairs joined by `.`. A `~` suffix names the restart (salt) that
 * assigned the variant, and a trailing `*` marks the visitor as exposed (counted once). Names and variants are
 * URL-safe tokens, so the value needs no encoding.
 */

/** A visitor's variant in one experiment. */
export interface ExperimentMembership {
  variant: string;
  /** The visitor has been counted as exposed to the experiment. */
  exposed: boolean;
  /**
   * Which restart of the experiment assigned the variant ({@link experimentGeneration} of its `salt`; absent for an
   * experiment without a salt). A changed salt voids the membership.
   */
  generation?: string;
}

/** Experiment names and variants travel in a cookie, so they stay URL-safe tokens. */
export const EXPERIMENT_TOKEN_RE = /^[A-Za-z0-9_-]{1,48}$/;
/** A cookie remembers this many experiments per visitor; later ones are not remembered (and not counted). */
export const MAX_COOKIE_EXPERIMENTS = 24;
/**
 * The most cached copies per page that running experiments may multiply into before the hit ratio suffers.
 * `hypdriv doctor` warns above it; the warmers and the URL purge enumerate at most this many variant combinations.
 */
export const MAX_EXPERIMENT_COPIES = 16;

const TOKEN = EXPERIMENT_TOKEN_RE;
const GENERATION = /^[a-z0-9]{1,8}$/;
const MAX_ENTRIES = MAX_COOKIE_EXPERIMENTS;
const MAX_LENGTH = 1800;

/**
 * The generation a salt stands for: empty without a salt, else a short hash. Memberships assigned under another
 * generation are void, so a changed `salt` restarts the experiment for every visitor.
 */
export function experimentGeneration(salt: string | undefined): string {
  return salt ? shortHash(salt).slice(-6) : '';
}

/** Reads the cookie value; malformed entries are dropped. */
export function parseExperimentCookie(
  value: string | null | undefined,
): Record<string, ExperimentMembership> {
  const out: Record<string, ExperimentMembership> = {};
  if (!value || value.length > 4096) return out;
  for (const entry of value.split('.')) {
    const exposed = entry.endsWith('*');
    const [pair, generation, spare] = (exposed ? entry.slice(0, -1) : entry).split('~');
    const [name, variant, extra] = (pair ?? '').split(':');
    if (extra !== undefined || spare !== undefined || !name || !variant) continue;
    if (!TOKEN.test(name) || !TOKEN.test(variant) || name === '__proto__') continue;
    if (generation !== undefined && !GENERATION.test(generation)) continue;
    if (Object.hasOwn(out, name)) continue;
    out[name] = { variant, exposed, ...(generation ? { generation } : {}) };
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
    const generation = m.generation && GENERATION.test(m.generation) ? `~${m.generation}` : '';
    const entry = `${name}:${m.variant}${generation}${m.exposed ? '*' : ''}`;
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

/**
 * The `Cookie` header of a warm-up request that asks for one variant per experiment (`{ checkout: 'b' }`), or `null`
 * when it asks for none. The flags stage serves a warm-up (`x-hypdriv-warm`) the variants this names, so each cached
 * copy of a page can be filled, without assigning, counting or giving a cookie to anyone.
 */
export function experimentWarmCookie(cookieName: string, assignment: Record<string, string>): string | null {
  const memberships: Record<string, ExperimentMembership> = {};
  for (const [name, variant] of Object.entries(assignment)) memberships[name] = { variant, exposed: false };
  const value = serializeExperimentCookie(memberships);
  return value ? `${cookieName}=${encodeURIComponent(value)}` : null;
}
