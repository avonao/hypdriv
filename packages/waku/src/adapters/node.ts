/// <reference path="../../virtual.d.ts" />
import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import wakuNode from 'waku/adapters/node';
import type { HypDrivAdapterOptions } from '../entry';
import { wrapNodeEntry } from '../node';

type Handlers = Parameters<typeof wakuNode>[0];
type WakuNodeOptions = NonNullable<Parameters<typeof wakuNode>[1]>;

/** Waku's Node adapter options, plus Hypdriv's under `hypdriv`. */
export type HypDrivNodeOptions = WakuNodeOptions & { hypdriv?: HypDrivAdapterOptions };

/**
 * Waku's Node adapter (`waku/adapters/node`) behind the Hypdriv Drivetrain: selected for Node builds by
 * `withHypDriv()` (`unstable_adapter`), or imported by a custom `src/waku.server.tsx`:
 *
 * ```ts
 * import { fsRouter } from 'waku';
 * import adapter from '@hypdriv/waku/adapters/node';
 * export default adapter(fsRouter(import.meta.glob('./pages/**\/*.{tsx,ts}')));
 * ```
 */
export default function adapter(handlers: Handlers, options?: HypDrivNodeOptions) {
  const { hypdriv, ...waku } = options ?? {};
  return wrapNodeEntry(wakuNode(handlers, waku), { config, manifest, ...hypdriv });
}
