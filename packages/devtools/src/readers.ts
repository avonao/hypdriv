import {
  base64UrlDecode,
  type Capabilities,
  type FlagValue,
  parseServerTiming,
  type TimingEntry,
  utf8Decode,
} from '@hypdriv/core';

export type VitalName = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';
export type VitalRating = 'good' | 'needs-improvement' | 'poor';

export interface VitalSample {
  name: VitalName;
  value: number;
  rating: VitalRating;
  /** `true` while the value may still change (LCP before interaction, CLS/INP during the session). */
  provisional: boolean;
}

/** Thresholds from web.dev (good ≤ first, poor > second). */
export const VITAL_THRESHOLDS: Record<VitalName, [number, number]> = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

export function rateVital(name: VitalName, value: number): VitalRating {
  const [good, poor] = VITAL_THRESHOLDS[name];
  if (value <= good) return 'good';
  if (value <= poor) return 'needs-improvement';
  return 'poor';
}

/** Structural `PerformanceServerTiming`. */
export interface ServerTimingLike {
  name: string;
  duration: number;
  description: string;
}

/** Parses a raw `Server-Timing` header (for responses the application fetched itself). */
export function parseServerTimingHeader(header: string | null | undefined): TimingEntry[] {
  return parseServerTiming(header);
}

/** Converts browser `serverTiming` entries to core's `TimingEntry` shape. */
export function serverTimingFromEntries(
  entries: readonly ServerTimingLike[] | null | undefined,
): TimingEntry[] {
  if (!entries) return [];
  return entries.map((e) => ({
    name: e.name,
    ...(Number.isFinite(e.duration) && (e.duration !== 0 || !e.description) ? { dur: e.duration } : {}),
    ...(e.description ? { desc: e.description } : {}),
  }));
}

interface NavigationEntryLike {
  serverTiming?: readonly ServerTimingLike[];
  responseStart?: number;
  requestStart?: number;
  startTime?: number;
  duration?: number;
}

function perf(): { getEntriesByType(type: string): unknown[] } | null {
  const p = (globalThis as { performance?: { getEntriesByType?: (type: string) => unknown[] } }).performance;
  return p && typeof p.getEntriesByType === 'function'
    ? (p as { getEntriesByType(type: string): unknown[] })
    : null;
}

/** Server-Timing entries of the current navigation (empty outside a browser). */
export function readServerTimingEntries(): TimingEntry[] {
  const nav = perf()?.getEntriesByType('navigation')[0] as NavigationEntryLike | undefined;
  return serverTimingFromEntries(nav?.serverTiming);
}

/** Time to first byte of the current navigation in ms, or `null`. */
export function readTtfb(): number | null {
  const nav = perf()?.getEntriesByType('navigation')[0] as NavigationEntryLike | undefined;
  if (!nav || typeof nav.responseStart !== 'number' || nav.responseStart <= 0) return null;
  return nav.responseStart - (nav.startTime ?? 0);
}

/** Summary of the stage entries DevTools highlights. */
export interface RequestSummary {
  entries: TimingEntry[];
  total: number | null;
  cache: string | null;
  csp: string | null;
  bot: string | null;
  limit: string | null;
  flags: string | null;
}

export function summarizeRequest(entries: TimingEntry[]): RequestSummary {
  const find = (name: string) => entries.find((e) => e.name === name);
  return {
    entries,
    total: find('total')?.dur ?? null,
    cache: find('cache')?.desc ?? null,
    csp: find('csp')?.desc ?? null,
    bot: find('bot')?.desc ?? null,
    limit: find('limit')?.desc ?? null,
    flags: find('flags')?.desc ?? null,
  };
}

/** Minimal document shape used by the meta readers (tests pass a fake). */
export interface DocumentLike {
  querySelector(selectors: string): { getAttribute(name: string): string | null } | null;
  querySelectorAll(selectors: string): ArrayLike<{ getAttribute(name: string): string | null }>;
}

function doc(explicit?: DocumentLike): DocumentLike | null {
  if (explicit) return explicit;
  const d = (globalThis as { document?: DocumentLike }).document;
  return d && typeof d.querySelector === 'function' ? d : null;
}

/** Reads `<meta name="<name>" content>`; `name` may omit the `hypdriv:` prefix. */
export function readMeta(name: string, document?: DocumentLike): string | null {
  const d = doc(document);
  if (!d) return null;
  const full = name.startsWith('hypdriv:') ? name : `hypdriv:${name}`;
  const el = d.querySelector(`meta[name="${full}"]`);
  const content = el?.getAttribute('content');
  return content === undefined || content === null || content === '' ? null : content;
}

/** Every `<meta name="hypdriv:*">` as a map without the prefix. */
export function readAllMeta(document?: DocumentLike): Record<string, string> {
  const d = doc(document);
  const out: Record<string, string> = {};
  if (!d) return out;
  const list = d.querySelectorAll('meta[name^="hypdriv:"]');
  for (let i = 0; i < list.length; i++) {
    const el = list[i]!;
    const name = el.getAttribute('name') ?? '';
    const content = el.getAttribute('content');
    if (name.startsWith('hypdriv:') && content) out[name.slice('hypdriv:'.length)] = content;
  }
  return out;
}

/** Decodes the flags encoding (base64url JSON, raw JSON tolerated) used by `<meta name="hypdriv:flags">`. */
export function decodeFlags(value: string | null | undefined): Record<string, FlagValue> | null {
  if (!value) return null;
  const trimmed = value.trim();
  let text = trimmed;
  if (!trimmed.startsWith('{')) {
    try {
      text = utf8Decode(base64UrlDecode(trimmed));
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, FlagValue> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))
        out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export function readFlagsMeta(document?: DocumentLike): Record<string, FlagValue> | null {
  return decodeFlags(readMeta('flags', document));
}

export interface BuildInfo {
  build: string | null;
  route: string | null;
  runner: string | null;
  deployment: string | null;
  requestId: string | null;
  locale: string | null;
  cache: string | null;
  csp: string | null;
  nextVersion: string | null;
  hypdrivVersion: string | null;
  /** Any other `hypdriv:*` meta tags. */
  extra: Record<string, string>;
}

const KNOWN_META = new Set([
  'build',
  'route',
  'runner',
  'deployment',
  'request-id',
  'request',
  'locale',
  'cache',
  'csp',
  'next',
  'version',
  'hypdriv',
  'flags',
]);

export function readBuildMeta(document?: DocumentLike): BuildInfo {
  const all = readAllMeta(document);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (!KNOWN_META.has(k)) extra[k] = v;
  return {
    build: all.build ?? null,
    route: all.route ?? null,
    runner: all.runner ?? null,
    deployment: all.deployment ?? null,
    requestId: all['request-id'] ?? all.request ?? null,
    locale: all.locale ?? null,
    cache: all.cache ?? null,
    csp: all.csp ?? null,
    nextVersion: all.next ?? null,
    hypdrivVersion: all.version ?? all.hypdriv ?? null,
    extra,
  };
}

/** One RSC payload fetch (`?_rsc=`) observed through resource timing. */
export interface RscNavigation {
  url: string;
  startTime: number;
  duration: number;
  entries: TimingEntry[];
  cache: string | null;
}

interface ResourceEntryLike {
  name: string;
  initiatorType?: string;
  startTime: number;
  duration: number;
  serverTiming?: readonly ServerTimingLike[];
}

export function rscNavigationFromEntry(entry: ResourceEntryLike): RscNavigation | null {
  if (!entry || typeof entry.name !== 'string' || !entry.name.includes('_rsc=')) return null;
  if (entry.initiatorType && entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest')
    return null;
  const entries = serverTimingFromEntries(entry.serverTiming);
  let url = entry.name;
  try {
    const u = new URL(entry.name);
    u.searchParams.delete('_rsc');
    url = `${u.pathname}${u.search}`;
  } catch {
    // keep raw
  }
  return {
    url,
    startTime: entry.startTime,
    duration: entry.duration,
    entries,
    cache: entries.find((e) => e.name === 'cache')?.desc ?? null,
  };
}

/** RSC navigations already recorded in the performance buffer. */
export function readRscNavigations(): RscNavigation[] {
  const list = (perf()?.getEntriesByType('resource') ?? []) as ResourceEntryLike[];
  const out: RscNavigation[] = [];
  for (const entry of list) {
    const nav = rscNavigationFromEntry(entry);
    if (nav) out.push(nav);
  }
  return out;
}

export interface PurserDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
}

export interface PurserStatus {
  ok: boolean;
  diagnostics: PurserDiagnostic[];
  atoms: number | null;
  builtAt: string | null;
  durationMs: number | null;
  stylesheet: string | null;
}

/**
 * Normalises `.hypdriv/dev/purser.json` as served by `<endpoint>/purser`. Tolerates `{ diagnostics }`,
 * `{ errors, warnings }` and `{ result: { ... } }` shapes.
 */
export function normalizePurser(raw: unknown): PurserStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj =
    (raw as { result?: unknown }).result && typeof (raw as { result?: unknown }).result === 'object'
      ? ((raw as { result: Record<string, unknown> }).result as Record<string, unknown>)
      : (raw as Record<string, unknown>);
  const diagnostics: PurserDiagnostic[] = [];
  const push = (items: unknown, fallback: PurserDiagnostic['severity']) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (typeof item === 'string') {
        diagnostics.push({ severity: fallback, message: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const d = item as Record<string, unknown>;
      const severityRaw =
        typeof d.severity === 'string' ? d.severity : typeof d.level === 'string' ? d.level : fallback;
      const severity: PurserDiagnostic['severity'] =
        severityRaw === 'error' || severityRaw === 'fatal'
          ? 'error'
          : severityRaw === 'warning' || severityRaw === 'warn'
            ? 'warning'
            : 'info';
      const message =
        typeof d.message === 'string' ? d.message : typeof d.text === 'string' ? d.text : JSON.stringify(d);
      diagnostics.push({
        severity,
        message,
        ...(typeof d.file === 'string'
          ? { file: d.file }
          : typeof d.path === 'string'
            ? { file: d.path }
            : {}),
        ...(typeof d.line === 'number' ? { line: d.line } : {}),
        ...(typeof d.column === 'number' ? { column: d.column } : {}),
        ...(typeof d.code === 'string' ? { code: d.code } : {}),
      });
    }
  };
  push(obj.diagnostics, 'info');
  push(obj.errors, 'error');
  push(obj.warnings, 'warning');
  const hasErrors = diagnostics.some((d) => d.severity === 'error');
  return {
    ok: typeof obj.ok === 'boolean' ? obj.ok : !hasErrors,
    diagnostics,
    atoms: typeof obj.atoms === 'number' ? obj.atoms : null,
    builtAt:
      typeof obj.builtAt === 'string'
        ? obj.builtAt
        : typeof obj.generatedAt === 'string'
          ? obj.generatedAt
          : null,
    durationMs: typeof obj.durationMs === 'number' ? obj.durationMs : null,
    stylesheet:
      typeof obj.stylesheet === 'string' ? obj.stylesheet : typeof obj.out === 'string' ? obj.out : null,
  };
}

/** Fetches Purser diagnostics from the dev endpoint; `null` when the bridge is not running. */
export async function readPurserDiagnostics(
  endpoint: string,
  fetchImpl: typeof fetch | undefined = globalThis.fetch,
): Promise<PurserStatus | null> {
  if (!fetchImpl) return null;
  try {
    const res = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/purser`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return normalizePurser(await res.json());
  } catch {
    return null;
  }
}

/**
 * JSON served by `<endpoint>/state` (`@hypdriv/cloudflare` internal routes / proxy dev routes). Both the
 * long (`buildId`, `nextVersion`, `hypdrivVersion`) and short (`build`, `next`, `hypdriv`) key spellings
 * are accepted.
 */
export interface DevState {
  capabilities: Partial<Capabilities> | null;
  /** `describeCapabilities()` lines, when the server includes them. */
  summary: string[];
  /** Config summary when the server sends one. */
  config: Record<string, unknown> | null;
  /** Remaining top-level keys (stages, routes, development, ...), shown as JSON. */
  details: Record<string, unknown>;
  runner: string | null;
  development: boolean | null;
  buildId: string | null;
  hypdrivVersion: string | null;
  nextVersion: string | null;
  raw: Record<string, unknown>;
}

const STATE_KNOWN = new Set([
  'capabilities',
  'summary',
  'config',
  'runner',
  'development',
  'buildId',
  'build',
  'hypdrivVersion',
  'hypdriv',
  'nextVersion',
  'next',
]);

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function normalizeDevState(raw: unknown): DevState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const capabilities =
    obj.capabilities && typeof obj.capabilities === 'object'
      ? (obj.capabilities as Partial<Capabilities>)
      : null;
  const details: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!STATE_KNOWN.has(k)) details[k] = v;
  return {
    capabilities,
    summary: Array.isArray(obj.summary) ? obj.summary.filter((s): s is string => typeof s === 'string') : [],
    config: obj.config && typeof obj.config === 'object' ? (obj.config as Record<string, unknown>) : null,
    details,
    runner: str(obj.runner),
    development: typeof obj.development === 'boolean' ? obj.development : null,
    buildId: str(obj.buildId) ?? str(obj.build),
    hypdrivVersion: str(obj.hypdrivVersion) ?? str(obj.hypdriv),
    nextVersion: str(obj.nextVersion) ?? str(obj.next),
    raw: obj,
  };
}

/** Fetches `<endpoint>/state` once; `null` when unavailable. */
export async function readDevState(
  endpoint: string,
  fetchImpl: typeof fetch | undefined = globalThis.fetch,
): Promise<DevState | null> {
  if (!fetchImpl) return null;
  try {
    const res = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/state`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return normalizeDevState(await res.json());
  } catch {
    return null;
  }
}

/** Everything the HUD shows, as one serialisable snapshot (also handy for bug reports). */
export interface DevToolsData {
  request: RequestSummary;
  vitals: Partial<Record<VitalName, VitalSample>>;
  navigations: RscNavigation[];
  flags: Record<string, FlagValue> | null;
  build: BuildInfo;
  purser: PurserStatus | null;
  state: DevState | null;
}

/**
 * Per-request facts the `devtools` stage writes as `Server-Timing` entries (`hyp-request`, `hyp-runner`,
 * `hyp-route`, `hyp-locale`, `hyp-flags`, `hyp-build`, `hyp-deployment`, `hyp-next`, `hyp-version`),
 * keyed without the `hyp-` prefix.
 */
export function readRequestFacts(entries: readonly TimingEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) if (e.name.startsWith('hyp-') && e.desc) out[e.name.slice(4)] = e.desc;
  return out;
}

/** Build info from meta tags overlaid with the per-request `Server-Timing` facts (which win). */
export function mergeBuildInfo(meta: BuildInfo, facts: Record<string, string>): BuildInfo {
  return {
    ...meta,
    build: facts.build ?? meta.build,
    route: facts.route ?? meta.route,
    runner: facts.runner ?? meta.runner,
    deployment: facts.deployment ?? meta.deployment,
    requestId: facts.request ?? meta.requestId,
    locale: facts.locale ?? meta.locale,
    nextVersion: facts.next ?? meta.nextVersion,
    hypdrivVersion: facts.version ?? meta.hypdrivVersion,
  };
}

/** Synchronous part of the snapshot (timings, meta tags, resource entries). */
export function collectDevToolsData(document?: DocumentLike): DevToolsData {
  const entries = readServerTimingEntries();
  const facts = readRequestFacts(entries);
  const ttfb = readTtfb();
  return {
    request: summarizeRequest(entries),
    vitals:
      ttfb === null
        ? {}
        : { TTFB: { name: 'TTFB', value: ttfb, rating: rateVital('TTFB', ttfb), provisional: false } },
    navigations: readRscNavigations(),
    flags: decodeFlags(facts.flags) ?? readFlagsMeta(document),
    build: mergeBuildInfo(readBuildMeta(document), facts),
    purser: null,
    state: null,
  };
}
