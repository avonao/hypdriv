import { assertManifest, type HypManifest } from '@hypdriv/core';

let cached: { at: number; manifest: HypManifest | null } | null = null;

/**
 * Reads `.hypdriv/manifest.json` from the working directory on Node runtimes (`next start`, `next dev`,
 * `proxy.ts`). The path is statically scoped (`process.cwd()` + literal segments) so Next's file tracing
 * includes only the manifest, never the whole project. Returns null on runtimes without a filesystem.
 * Results are cached for `ttlMs` (default 5 s) so a rebuilt manifest is picked up in development.
 */
export async function readManifestFile(ttlMs = 5000): Promise<HypManifest | null> {
  const now = Date.now();
  if (cached && now - cached.at < ttlMs) return cached.manifest;
  let manifest: HypManifest | null = null;
  try {
    const proc = (globalThis as { process?: { versions?: { node?: string }; cwd?: () => string } }).process;
    if (proc?.versions?.node && typeof proc.cwd === 'function') {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const parsed = JSON.parse(
        await readFile(join(proc.cwd(), '.hypdriv', 'manifest.json'), 'utf8'),
      ) as HypManifest;
      assertManifest(parsed);
      manifest = parsed;
    }
  } catch {
    manifest = null;
  }
  cached = { at: now, manifest };
  return manifest;
}

/** Test seam. */
export function resetManifestFileCache(): void {
  cached = null;
}
