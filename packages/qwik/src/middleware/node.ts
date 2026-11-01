/// <reference path="../../virtual.d.ts" />
import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import { type HypDrivQwikNodeRouter, type QwikRouterNodeOptions, wrapNode } from '../node';

export type { HypDrivNodeOptions, HypDrivQwikNodeRouter, QwikRouterNodeOptions } from '../node';

/**
 * Qwik Router's Node entry behind the Drivetrain. Same shape as `createQwikRouter` of
 * `@qwik.dev/router/middleware/node` (`router`, `staticFile`, `notFound`), plus `listener`, the complete `http`
 * request listener:
 *
 * ```tsx
 * // src/entry.node.tsx
 * import { createServer } from 'node:http';
 * import { createQwikRouter } from '@hypdriv/qwik/middleware/node';
 * import render from './entry.ssr';
 *
 * const { listener } = createQwikRouter({ render });
 * createServer(listener).listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
 * ```
 */
export function createQwikRouter(options: QwikRouterNodeOptions): HypDrivQwikNodeRouter {
  const { hypdriv, ...qwik } = options;
  return wrapNode(qwik, { config, manifest, ...hypdriv });
}
