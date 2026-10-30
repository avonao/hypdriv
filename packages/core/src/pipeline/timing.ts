import { now } from '../util/runtime';

export interface TimingEntry {
  name: string;
  /** Milliseconds; undefined for marker entries. */
  dur?: number;
  desc?: string;
}

export type ServerTimingMode = 'off' | 'compact' | 'verbose';

/** Collects per-stage timings and renders a `Server-Timing` header. */
export class Timings {
  private readonly entries: TimingEntry[] = [];
  readonly startedAt = now();

  start(name: string): (desc?: string) => number {
    const t0 = now();
    return (desc) => {
      const dur = now() - t0;
      this.entries.push({ name, dur, ...(desc ? { desc } : {}) });
      return dur;
    };
  }

  /** Records a duration measured elsewhere. */
  record(name: string, dur: number, desc?: string): void {
    this.entries.push({ name, dur, ...(desc ? { desc } : {}) });
  }

  /** Records a marker without a duration (`cache;desc=HIT`). */
  mark(name: string, desc?: string): void {
    this.entries.push({ name, ...(desc ? { desc } : {}) });
  }

  elapsed(): number {
    return now() - this.startedAt;
  }

  list(): readonly TimingEntry[] {
    return this.entries;
  }

  /**
   * Renders the header. `compact` keeps `total`, `cache`, `csp`, the DevTools `hyp-*` facts and any entry
   * whose name starts with `app.`; `verbose` includes every stage. Names are sanitised to tokens,
   * descriptions quoted.
   */
  toHeader(mode: ServerTimingMode): string {
    if (mode === 'off') return '';
    const keep = (e: TimingEntry) =>
      mode === 'verbose' ||
      COMPACT_KEEP.has(e.name) ||
      e.name.startsWith('app.') ||
      e.name.startsWith('hyp-');
    const merged = new Map<string, TimingEntry>();
    for (const e of this.entries) {
      if (!keep(e)) continue;
      const prev = merged.get(e.name);
      if (prev && prev.dur !== undefined && e.dur !== undefined)
        merged.set(e.name, { ...e, dur: prev.dur + e.dur, desc: e.desc ?? prev.desc });
      else merged.set(e.name, e);
    }
    const parts = [...merged.values()].map(serializeEntry);
    parts.push(serializeEntry({ name: 'total', dur: this.elapsed() }));
    return parts.join(', ');
  }
}

const COMPACT_KEEP = new Set(['cache', 'csp', 'next', 'limit', 'bot', 'total', 'flags']);

function serializeEntry(e: TimingEntry): string {
  const name = e.name.replace(/[^A-Za-z0-9_.-]/g, '_');
  let out = name;
  if (e.dur !== undefined) out += `;dur=${e.dur < 10 ? e.dur.toFixed(2) : e.dur.toFixed(1)}`;
  // DevTools facts (`hyp-*`, e.g. encoded public flags) may be longer than ordinary descriptions.
  if (e.desc)
    out += `;desc=${JSON.stringify(e.desc.replace(/[\r\n"]/g, ' ').slice(0, name.startsWith('hyp-') ? 1024 : 120))}`;
  return out;
}

/** Parses a Server-Timing header (used by DevTools and tests). */
export function parseServerTiming(header: string | null | undefined): TimingEntry[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...params] = part.split(';').map((s) => s.trim());
      const entry: TimingEntry = { name: name ?? '' };
      for (const p of params) {
        const [k, v] = p.split('=');
        if (k === 'dur' && v !== undefined) entry.dur = Number(v);
        if (k === 'desc' && v !== undefined) entry.desc = v.replace(/^"|"$/g, '');
      }
      return entry;
    });
}
