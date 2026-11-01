import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { VercelRoute } from '@hypdriv/build';

interface VercelConfigJson {
  version: number;
  routes?: VercelRoute[];
  overrides?: Record<string, { path?: string; contentType?: string }>;
  [key: string]: unknown;
}

/** A prerendered document in `.vercel/output/static`: `about/index.html`, served under the app's base path. */
export interface StaticDocumentFile {
  relative: string;
  basePath: string;
}

/**
 * Serves prerendered documents at their clean URL on Vercel's CDN (`about/index.html` at `/about`) through Build
 * Output `overrides`, so the CDN answers `/about` from the file (with its static header rule and Hypdriv's Routing
 * Middleware) instead of invoking Waku's function. Returns the number of documents mapped.
 */
export function writeVercelOverrides(outputDir: string, documents: StaticDocumentFile[]): number {
  const file = join(outputDir, 'config.json');
  if (!existsSync(file)) return 0;
  const config = JSON.parse(readFileSync(file, 'utf8')) as VercelConfigJson;
  const overrides = { ...(config.overrides ?? {}) };
  let mapped = 0;
  for (const doc of documents) {
    const path = doc.relative.replace(/(?:^|\/)index\.html$/, '');
    // The root document is served at `/` as it is (unless the app lives under a base path).
    const url = posix.join(doc.basePath.replace(/^\/+/, ''), path);
    if (!url || url === '.') continue;
    overrides[doc.relative] = {
      ...overrides[doc.relative],
      path: url,
      contentType: 'text/html; charset=utf-8',
    };
    mapped++;
  }
  config.overrides = overrides;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return mapped;
}
