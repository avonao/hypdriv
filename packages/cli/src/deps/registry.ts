import { highestVersion } from '../semver';

export const NPM_REGISTRY = 'https://registry.npmjs.org';

export interface RegistryInfo {
  name: string;
  /** `dist-tags.latest`. */
  latest: string | null;
  /** Highest stable version among `versions` (falls back to `latest`). */
  latestStable: string | null;
  /** Publish time of `latest` when the document carries it. */
  publishedAt: string | null;
  /** Last modification of the package document. */
  modified: string | null;
  error: string | null;
}

export interface RegistryOptions {
  fetch: typeof fetch;
  registry?: string;
  timeoutMs?: number;
  concurrency?: number;
  /** Extra headers (auth tokens for private registries). */
  headers?: Record<string, string>;
}

interface AbbreviatedDoc {
  name?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, unknown>;
  modified?: string;
  time?: Record<string, string>;
}

/** Fetches the abbreviated package document (`application/vnd.npm.install-v1+json`). */
export async function fetchPackageInfo(name: string, options: RegistryOptions): Promise<RegistryInfo> {
  const base = (options.registry ?? NPM_REGISTRY).replace(/\/$/, '');
  const url = `${base}/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
  const timeout = options.timeoutMs ?? 10_000;
  const empty: RegistryInfo = {
    name,
    latest: null,
    latestStable: null,
    publishedAt: null,
    modified: null,
    error: null,
  };
  try {
    const res = await options.fetch(url, {
      headers: {
        accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return { ...empty, error: `HTTP ${res.status}` };
    const doc = (await res.json()) as AbbreviatedDoc;
    const latest = doc['dist-tags']?.latest ?? null;
    const versions = Object.keys(doc.versions ?? {});
    const latestStable = highestVersion(versions) ?? latest;
    return {
      name,
      latest,
      latestStable,
      publishedAt: latest && doc.time?.[latest] ? doc.time[latest]! : null,
      modified: doc.modified ?? doc.time?.modified ?? null,
      error: null,
    };
  } catch (err) {
    return { ...empty, error: (err as Error).message };
  }
}

/** Looks up many packages with bounded concurrency (default 8). */
export async function fetchPackageInfos(
  names: string[],
  options: RegistryOptions,
): Promise<Map<string, RegistryInfo>> {
  const unique = [...new Set(names)];
  const results = new Map<string, RegistryInfo>();
  const concurrency = Math.max(1, options.concurrency ?? 8);
  let index = 0;
  const worker = async () => {
    for (;;) {
      const i = index++;
      if (i >= unique.length) return;
      const name = unique[i]!;
      results.set(name, await fetchPackageInfo(name, options));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
  return results;
}
