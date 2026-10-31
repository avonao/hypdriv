import { type Dirent, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StaticHeaderRule } from '@hypdriv/build';
import type { StartDocument } from './documents';

/** Deployment targets Hypdriv writes static configuration for. */
export type StartTarget = 'cloudflare' | 'vercel' | 'node';

/** The parts of a Nitro instance Hypdriv's Nitro module reads (Nitro 3; structural, no dependency on `nitro`). */
export interface NitroLike {
  options: {
    preset: string;
    rootDir?: string;
    static?: boolean;
    output: { dir: string; serverDir: string; publicDir: string };
    routeRules: Record<string, Record<string, unknown> & { headers?: Record<string, string> | false }>;
  };
}

/** A Nitro module carried by a Vite plugin (`plugin.nitro`): Nitro installs it when it initialises. */
export interface NitroModuleLike {
  name: string;
  setup(nitro: NitroLike): void | Promise<void>;
}

/** The Hypdriv target a Nitro preset deploys to (`vercel`, `cloudflare-module`, `node-server`, `bun`…). */
export function targetForNitroPreset(preset: string | undefined): StartTarget {
  const p = (preset ?? '').replace(/_/g, '-').toLowerCase();
  if (p.startsWith('vercel')) return 'vercel';
  if (p.startsWith('cloudflare')) return 'cloudflare';
  return 'node';
}

/**
 * Nitro `routeRules` for a Node server: the static rules that cover files Nitro serves before any application
 * code runs (content-hashed assets). Document and catch-all rules are left out on purpose: Nitro's rule headers
 * override the application's response headers, and every page on Node is rendered by Start behind the Hypdriv
 * middleware, which sets its own headers.
 */
export function nodeRouteRules(
  rules: StaticHeaderRule[],
): Record<string, { headers: Record<string, string> }> {
  const base = rules.find((r) => r.path === '/*')?.set ?? {};
  const out: Record<string, { headers: Record<string, string> }> = {};
  for (const rule of rules) {
    if (rule.path === '/*' || !rule.path.endsWith('/*')) continue;
    out[`${rule.path.slice(0, -2)}/**`] = { headers: { ...base, ...rule.set } };
  }
  return out;
}

interface VercelConfigJson {
  version: number;
  overrides?: Record<string, { path?: string; contentType?: string }>;
  [key: string]: unknown;
}

/**
 * Serves prerendered documents at their clean URL on Vercel's CDN (`about.html` and `about/index.html` at
 * `/about`) through Build Output `overrides`, so the CDN answers `/about` from the file with its static header
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

const TEXT_FILE = /\.(?:m?js|cjs|map|json)$/;

/**
 * Removes the build's prerender token from server output (bundles and source maps), so a deployed server never
 * accepts it: the emptied token disables the prerender bypass. Returns the files changed.
 */
export function scrubPrerenderToken(dirs: string[], token: string): string[] {
  if (!token) return [];
  const changed: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Traced dependencies never embed the build's virtual modules.
        if (entry.name !== 'node_modules') walk(full);
        continue;
      }
      if (!entry.isFile() || !TEXT_FILE.test(entry.name) || seen.has(full)) continue;
      seen.add(full);
      try {
        if (statSync(full).size > 64 * 1024 * 1024) continue;
        const text = readFileSync(full, 'utf8');
        if (!text.includes(token)) continue;
        writeFileSync(full, text.split(token).join(''));
        changed.push(full);
      } catch {
        // unreadable file: skip
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return changed;
}
