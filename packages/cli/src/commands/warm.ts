import type { HypManifest } from '@hypdriv/core';
import { UsageError } from '../args';
import { cacheStatus } from '../audit/cache';
import { fetchPage, joinUrl, mapConcurrent, normalizeBaseUrl } from '../audit/http';
import { concretePaths, isPageRoute } from '../audit/paths';
import { createContext } from '../context';
import { millis } from '../ui';
import { defineCommand } from './types';

/** Paths to warm: configured `cache.warm.routes`, else every static/ISR page (concrete paths). */
export function warmPaths(manifest: HypManifest | null, configured: string[], explicit: string[]): string[] {
  if (explicit.length) return [...new Set(explicit)];
  if (configured.length) return [...new Set(configured)];
  if (!manifest) return ['/'];
  const out = new Set<string>();
  for (const route of manifest.routes) {
    if (!isPageRoute(route) || route.pathname.startsWith('/_')) continue;
    if (route.classification !== 'static' && route.classification !== 'isr') continue;
    for (const p of concretePaths(route, manifest.basePath)) out.add(p);
  }
  return out.size ? [...out] : ['/'];
}

export const warmCommand = defineCommand({
  name: 'warm',
  summary:
    'Fetch the configured warm routes (or all static/ISR routes) to fill the edge cache after a deploy',
  usage: 'hypdriv warm --url <base> [--concurrency 4] [--paths a,b]',
  options: {
    url: { type: 'string', value: '<base>', description: 'Base URL of the deployment' },
    paths: {
      type: 'string',
      value: '<a,b>',
      description: 'Explicit paths (default: cache.warm.routes, else static/ISR routes)',
      multiple: true,
    },
    concurrency: {
      type: 'string',
      value: '<n>',
      description: 'Parallel requests (default: cache.warm.concurrency)',
    },
    timeout: { type: 'string', value: '<ms>', description: 'Per-request timeout', default: '10000' },
  },
  examples: [
    'hypdriv warm --url https://www.example.com',
    'hypdriv warm --url http://localhost:8787 --paths /,/pricing --json',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const base = normalizeBaseUrl(args.string('url'));
    if (!base) throw new UsageError('--url <base> is required');
    const config = await ctx.loadConfig();
    const manifest = ctx.manifest();
    const paths = warmPaths(manifest, config.resolved.cache.warm.routes, args.list('paths'));
    const concurrency = args.number('concurrency', config.resolved.cache.warm.concurrency, {
      min: 1,
      max: 64,
    });
    const timeoutMs = args.number('timeout', 10_000, { min: 100 });
    if (!args.json) ui.heading(`Warming ${paths.length} path(s) on ${base} (concurrency ${concurrency})`);
    const results = await mapConcurrent(paths, concurrency, async (path) => {
      const page = await fetchPage(
        joinUrl(base, path),
        { fetch: io.fetch, timeoutMs, follow: false },
        io.now,
      );
      const row = {
        path,
        status: page.status,
        cache: cacheStatus(page.headers),
        ms: Math.round(page.totalMs),
        bytes: Buffer.byteLength(page.body),
        error: page.error,
      };
      if (!args.json) {
        const level = page.error || page.status >= 500 ? 'fail' : page.status >= 400 ? 'warn' : 'pass';
        ui.status(
          level,
          `${path}`,
          page.error ?? `${page.status} · ${row.cache ?? 'no cache header'} · ${millis(page.totalMs)}`,
        );
      }
      return row;
    });
    const failed = results.filter((r) => r.error || r.status >= 500);
    if (args.json) ui.printJson({ url: base, results, failed: failed.length });
    else {
      ui.line();
      ui.status(
        failed.length ? 'fail' : 'pass',
        `${results.length - failed.length}/${results.length} warmed${failed.length ? `, ${failed.length} failed` : ''}.`,
      );
    }
    return failed.length ? 1 : 0;
  },
});
