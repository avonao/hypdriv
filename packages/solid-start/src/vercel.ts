import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StartDocument } from './documents';

interface VercelConfigJson {
  version: number;
  overrides?: Record<string, { path?: string; contentType?: string }>;
  [key: string]: unknown;
}

/**
 * Serves prerendered documents at their clean URL on Vercel's CDN (`about/index.html` and `docs.html` at `/about`
 * and `/docs`) through Build Output `overrides`, so the CDN answers `/about` from the file with its static header
 * rule instead of invoking the function. Returns the number of documents mapped.
 */
export function writeVercelOverrides(outputDir: string, documents: StartDocument[]): number {
  const file = join(outputDir, 'config.json');
  if (!existsSync(file)) return 0;
  const config = JSON.parse(readFileSync(file, 'utf8')) as VercelConfigJson;
  const overrides = { ...(config.overrides ?? {}) };
  let mapped = 0;
  for (const doc of documents) {
    const path = doc.relative === 'index.html' ? null : doc.relative.replace(/(?:\/index)?\.html$/, '');
    if (!path) continue;
    overrides[doc.relative] = { ...overrides[doc.relative], path, contentType: 'text/html; charset=utf-8' };
    mapped++;
  }
  config.overrides = overrides;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return mapped;
}
