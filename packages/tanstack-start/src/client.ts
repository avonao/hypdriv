/**
 * Browser build of `@hypdriv/tanstack-start` (the `browser` export condition). `src/start.ts` and `src/router.tsx`
 * are part of the client bundle as well, but request middleware never runs in the browser and the router reads
 * the nonce back from `<meta property="csp-nonce">` there: these stand-ins keep the server runtime, the Hypdriv
 * config and the build manifest out of the client bundle.
 */
import { createMiddleware } from '@tanstack/react-start';
import type {
  HypDrivMiddlewareOptions,
  HypDrivRequestMiddlewareOptions,
  ServerFnCsrfMiddleware,
} from './index';
import type {
  CreateHypDrivMiddlewareOptions,
  HypDrivMiddlewareWithHandler,
  HypDrivRequestMiddleware,
  HypDrivStartContext,
} from './middleware';
import type { HypDrivSsrOptions } from './ssr';

export { PRERENDER_HEADER } from './constants';
export type {
  CloudflareStartContext,
  CreateHypDrivMiddlewareOptions,
  HypDrivMiddlewareWithHandler,
  HypDrivRequestMiddleware,
  HypDrivStartContext,
} from './middleware';
export type { HypDrivSsrOptions } from './ssr';
export type { HypDrivMiddlewareOptions, HypDrivRequestMiddlewareOptions, ServerFnCsrfMiddleware };

function inert(): HypDrivMiddlewareWithHandler {
  return createMiddleware({ type: 'request' }).server<HypDrivStartContext>(({ next }) =>
    next(),
  ) as HypDrivMiddlewareWithHandler;
}

let shared: HypDrivMiddlewareWithHandler | null = null;
let sharedList: readonly [HypDrivRequestMiddleware, ServerFnCsrfMiddleware] | null = null;

export function hypdrivMiddleware(_options?: HypDrivMiddlewareOptions): HypDrivMiddlewareWithHandler {
  shared ??= inert();
  return shared;
}

export function createHypDrivMiddleware(
  _options: CreateHypDrivMiddlewareOptions,
): HypDrivMiddlewareWithHandler {
  return hypdrivMiddleware();
}

export function hypdrivRequestMiddleware(
  _options?: HypDrivRequestMiddlewareOptions,
): readonly [HypDrivRequestMiddleware, ServerFnCsrfMiddleware] {
  sharedList ??= [hypdrivMiddleware(), inert() as unknown as ServerFnCsrfMiddleware] as const;
  return sharedList;
}

/** The client side of `hypdrivSsr()`: the router reads the nonce from the document's `csp-nonce` meta tag. */
export function hypdrivSsr(): HypDrivSsrOptions | undefined {
  return undefined;
}

export function isPrerenderRequest(_request: Request, _token: string | undefined): boolean {
  return false;
}
