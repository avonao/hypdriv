import { buildVitalsSnapshot, trendBucketSeconds, weightedQuantile } from './stats';
import type {
  VitalName,
  VitalRating,
  VitalsPayload,
  VitalsQuery,
  VitalsSink,
  VitalsSnapshot,
  VitalsSource,
} from './types';

interface Entry {
  name: VitalName;
  value: number;
  rating: VitalRating;
  route: string;
  pathname: string;
  at: number;
  weight: number;
}

export interface MemoryVitalsOptions {
  /** Measurements kept; the oldest are dropped first (default 5000). */
  capacity?: number;
  /** The beacon sample rate: each kept measurement stands for `1 / sampleRate` page views (default 1). */
  sampleRate?: number;
  now?: () => number;
}

export interface MemoryVitals {
  sink: VitalsSink;
  source: VitalsSource;
  /** Measurements currently held. */
  size(): number;
  clear(): void;
}

/**
 * A ring buffer of recent measurements that is both a sink and a dashboard source. It works without any
 * infrastructure and is exact on a single long-lived Node process; on Workers and Vercel it only sees the
 * traffic of one instance, which the snapshot flags as `partial`.
 */
export function memoryVitals(options: MemoryVitalsOptions = {}): MemoryVitals {
  const capacity = Math.max(10, Math.floor(options.capacity ?? 5000));
  const weight = options.sampleRate && options.sampleRate > 0 ? 1 / Math.min(1, options.sampleRate) : 1;
  const clock = options.now ?? Date.now;
  const ring: Array<Entry | undefined> = new Array(capacity);
  let next = 0;
  let size = 0;

  const sink: VitalsSink = {
    write(p: VitalsPayload) {
      ring[next] = {
        name: p.name,
        value: p.value,
        rating: p.rating,
        route: (p.route ?? p.pathname).slice(0, 96),
        pathname: p.pathname,
        at: clock(),
        weight,
      };
      next = (next + 1) % capacity;
      size = Math.min(capacity, size + 1);
    },
  };

  const source: VitalsSource = {
    async query(query: VitalsQuery): Promise<VitalsSnapshot> {
      const now = query.now ?? clock();
      const days = Math.min(90, Math.max(1, Math.floor(query.days)));
      const since = now - days * 86_400_000;
      const bucketSeconds = trendBucketSeconds(days);
      const bucketMs = bucketSeconds * 1000;
      const entries = ring.filter(
        (e): e is Entry =>
          e !== undefined &&
          e.at > since &&
          (!query.route || e.route === query.route || e.pathname === query.route),
      );

      type Samples = Array<{ value: number; weight: number }>;
      const group = <K>(key: (e: Entry) => K | null): Map<string, { key: K; samples: Samples }> => {
        const out = new Map<string, { key: K; samples: Samples }>();
        for (const e of entries) {
          const k = key(e);
          if (k === null) continue;
          const id = JSON.stringify(k);
          const bucket = out.get(id) ?? { key: k, samples: [] };
          bucket.samples.push({ value: e.value, weight: e.weight });
          out.set(id, bucket);
        }
        return out;
      };
      const total = (s: Samples) => s.reduce((n, x) => n + x.weight, 0);

      const overall = [...group((e) => e.name)].map(([, g]) => ({
        metric: g.key as string,
        p75: weightedQuantile(g.samples, 0.75),
        p50: weightedQuantile(g.samples, 0.5),
        samples: total(g.samples),
      }));
      const routes = [...group((e) => [e.route, e.name] as const)].map(([, g]) => ({
        route: g.key[0],
        metric: g.key[1],
        p75: weightedQuantile(g.samples, 0.75),
        p50: weightedQuantile(g.samples, 0.5),
        samples: total(g.samples),
      }));
      const trend = [...group((e) => [Math.floor(e.at / bucketMs) * bucketMs, e.name] as const)].map(
        ([, g]) => ({
          bucket: g.key[0],
          metric: g.key[1],
          p75: weightedQuantile(g.samples, 0.75),
          samples: total(g.samples),
        }),
      );
      const distribution = [...group((e) => [e.name, e.rating] as const)].map(([, g]) => ({
        metric: g.key[0],
        rating: g.key[1],
        samples: total(g.samples),
      }));

      return buildVitalsSnapshot(
        { overall, routes, trend, distribution },
        {
          source: {
            kind: 'memory',
            label: 'Recent measurements held by this server instance',
            partial: true,
          },
          days,
          route: query.route ?? null,
          now,
          bucketSeconds,
        },
      );
    },
  };

  return {
    sink,
    source,
    size: () => size,
    clear() {
      ring.fill(undefined);
      next = 0;
      size = 0;
    },
  };
}
