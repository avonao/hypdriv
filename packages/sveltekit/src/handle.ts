import type { GeoProperties, HypDrivConfig, HypDrivEnv } from '@hypdriv/core';
import {
  type CreateHandlerOptions,
  createHandler,
  nonce as currentNonce,
  type HandleInput,
  type HypHandler,
} from '@hypdriv/runtime';
import { adoptSvelteKitCsp, type SvelteKitCsp, withSvelteKitCsp } from './csp';

/** The parts of SvelteKit's `RequestEvent` the hook reads (structural, so it works across SvelteKit versions). */
export interface RequestEventLike {
  request: Request;
  platform?: unknown;
  isSubRequest?: boolean;
  getClientAddress(): string;
}

/** SvelteKit's `handle` signature, structurally. */
export type HandleLike<E extends RequestEventLike = RequestEventLike> = (input: {
  event: E;
  resolve: (event: E, opts?: never) => Promise<Response>;
}) => Promise<Response>;

/** Options of `hypdriv()` (the handle). */
export interface HypDrivHandleOptions
  extends Pick<
    CreateHandlerOptions,
    'stages' | 'onError' | 'devState' | 'development' | 'platform' | 'target'
  > {
  /** Requests that skip the pipeline (default: build assets outside `/api/`). */
  skip?: CreateHandlerOptions['skip'];
}

/** What the integration passes besides the user's options. */
export interface SvelteKitHandleInput extends HypDrivHandleOptions {
  config: HypDrivConfig;
  manifest: CreateHandlerOptions['manifest'];
  /** SvelteKit's `csp` option (its directives join HypDriv's policy). */
  csp?: SvelteKitCsp | null;
  /** SvelteKit is analysing or prerendering the app (`building` from `$app/env`): the hook passes through. */
  building: () => boolean;
  /** The Vite dev server (`dev` from `$app/env`). */
  dev?: () => boolean;
}

/** The global slot the hook registers its handler in, for HypDriv's Node server (`@hypdriv/sveltekit/node`). */
export const HANDLER_SLOT = Symbol.for('hypdriv.sveltekit.handler');

/** The handler the application's `handle` hook created, when the server build has one (Node server). */
export function registeredHandler(): HypHandler | null {
  return ((globalThis as Record<symbol, unknown>)[HANDLER_SLOT] as HypHandler | undefined) ?? null;
}

/** Platform inputs of a request: Cloudflare `cf`, bindings and `waitUntil` when an adapter exposes them, the client IP. */
export function platformInput(event: RequestEventLike, trustSocket: boolean): Omit<HandleInput, 'upstream'> {
  const out: Omit<HandleInput, 'upstream'> = {};
  const platform = (event.platform ?? null) as {
    env?: unknown;
    cf?: unknown;
    context?: { waitUntil?: unknown };
    ctx?: { waitUntil?: unknown };
    req?: unknown;
  } | null;
  const cf = (event.request as { cf?: unknown }).cf ?? platform?.cf;
  if (cf && typeof cf === 'object') out.cf = cf as GeoProperties;
  if (platform?.env && typeof platform.env === 'object') out.env = platform.env as HypDrivEnv;
  const context = platform?.context ?? platform?.ctx;
  if (context && typeof context.waitUntil === 'function') {
    const waitUntil = context.waitUntil.bind(context) as (p: Promise<unknown>) => void;
    out.waitUntil = (p) => waitUntil(p);
  }
  // On Node (adapter-node passes `platform.req`, the dev server) SvelteKit knows the client address from the
  // socket or the configured ADDRESS_HEADER; on Cloudflare and Vercel the platform's headers are authoritative.
  if (trustSocket || platform?.req) {
    try {
      const ip = event.getClientAddress();
      if (typeof ip === 'string' && ip) out.ip = ip.split(',')[0]!.trim();
    } catch {
      // the adapter cannot tell the client address
    }
  }
  return out;
}

/**
 * Builds SvelteKit's `handle` around `createHandler()`. The pipeline owns the full response (upstream =
 * `resolve(event)` with the forwarded request), passes through while SvelteKit builds and prerenders, for
 * SvelteKit's internal sub-requests (`event.fetch` to the app itself) and inside an outer HypDriv runner (the
 * Cloudflare Worker shell, HypDriv's Node server). A policy SvelteKit adds (its `csp` option) is folded into
 * HypDriv's: same nonce, one header.
 */
export function createSvelteKitHandle<E extends RequestEventLike>(
  input: SvelteKitHandleInput,
): {
  handle: HandleLike<E>;
  handler: HypHandler;
} {
  const { config, manifest, csp, building, dev, ...rest } = input;
  const handler = createHandler({
    ...rest,
    config: withSvelteKitCsp(config, csp),
    manifest,
    host: 'sveltekit',
  });
  const handle: HandleLike<E> = async ({ event, resolve }) => {
    if (building()) return resolve(event);
    const render = async (request: Request): Promise<Response> => {
      const target = request === event.request ? event : ({ ...event, request } as E);
      const response = await resolve(target);
      return adoptSvelteKitCsp(response, currentNonce());
    };
    if (event.isSubRequest) return render(event.request);
    return handler(event.request, { upstream: render, ...platformInput(event, dev?.() ?? false) });
  };
  return { handle, handler };
}
