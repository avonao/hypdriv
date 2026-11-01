/// <reference path="../../virtual.d.ts" />
import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import wakuVercel from 'waku/adapters/vercel';
import { type HypDrivAdapterOptions, wrapEntry } from '../entry';

type Handlers = Parameters<typeof wakuVercel>[0];
type WakuVercelOptions = NonNullable<Parameters<typeof wakuVercel>[1]>;

/** Waku's Vercel adapter options, plus Hypdriv's under `hypdriv`. */
export type HypDrivVercelOptions = WakuVercelOptions & { hypdriv?: HypDrivAdapterOptions };

/**
 * Waku's Vercel adapter (`waku/adapters/vercel`) behind the Hypdriv Drivetrain. The Build Output API function
 * Waku writes runs the pipeline for every request that reaches it (dynamic pages, RSC payloads, server functions,
 * API routes); prerendered pages the CDN serves get Hypdriv's Routing Middleware and static header rules from the
 * Vite plugin.
 */
export default function adapter(handlers: Handlers, options?: HypDrivVercelOptions) {
  const { hypdriv, ...waku } = options ?? {};
  return wrapEntry(wakuVercel(handlers, waku), { config, manifest, ...hypdriv });
}
