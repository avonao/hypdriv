import type { GeoProperties, HypDrivConfig, HypDrivEnv, ResolvedConfig } from '@hypdriv/core';
import {
  type CreateHandlerOptions,
  createHandler,
  type HandleInput,
  type HypHandler,
  type ManifestSource,
} from '@hypdriv/runtime';
import type { Unstable_ServerEntry } from 'waku/adapter-builders';

/** The label reported in logs and `/_hypdriv/health`. */
export const HOST_LABEL = 'waku';

/** Waku's complete request and build entry, as an adapter returns it. */
export type WakuServerEntry = Unstable_ServerEntry;

/**
 * Hypdriv's options in a Waku adapter call (`adapter(fsRouter(modules), { hypdriv: { … } })`). The config and the
 * manifest come from the Hypdriv Vite plugin (`hypdriv.config.ts`, `.hypdriv/manifest`) unless given here.
 */
export interface HypDrivAdapterOptions extends Omit<CreateHandlerOptions, 'config' | 'manifest' | 'host'> {
  config?: HypDrivConfig | ResolvedConfig;
  manifest?: ManifestSource;
  /** The framework label (default `waku`). */
  host?: string;
}

/** What an adapter wrapper needs: the plugin's modules plus the application's own options. */
export interface WrapOptions extends HypDrivAdapterOptions {
  config: HypDrivConfig | ResolvedConfig;
  manifest: ManifestSource;
}

interface ExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
}

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } };
}

/** `@hono/node-server` hands `{ incoming, outgoing }` to `fetch` as the bindings: not an environment. */
function isNodeBindings(env: unknown): env is NodeBindings & object {
  return typeof env === 'object' && env !== null && 'incoming' in env && 'outgoing' in env;
}

/** An IPv4-mapped IPv6 address (`::ffff:203.0.113.9`, what a dual-stack Node socket reports) as plain IPv4. */
function plainAddress(address: string): string {
  return /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1] ?? address;
}

/**
 * The platform facts the arguments after the request carry, as `createHandler` input: the socket address on Node
 * (used unless the config says the server sits behind proxies, whose forwarded headers decide instead), Cloudflare
 * bindings and `ctx.waitUntil`, `request.cf`. Anything missing falls back inside `createHandler` (`process.env`,
 * Vercel's request context, forwarded headers).
 */
export function platformInput(
  request: Request,
  args: unknown[],
  config: ResolvedConfig,
): Pick<HandleInput, 'env' | 'waitUntil' | 'ip' | 'cf'> {
  const out: Pick<HandleInput, 'env' | 'waitUntil' | 'ip' | 'cf'> = {};
  const [first, second] = args;
  if (isNodeBindings(first)) {
    const address = first.incoming?.socket?.remoteAddress;
    if (address && config.security.trustedProxies === 0) out.ip = plainAddress(address);
  } else if (first && typeof first === 'object') {
    out.env = first as HypDrivEnv;
  }
  const ctx = second as ExecutionContextLike | undefined;
  if (ctx && typeof ctx.waitUntil === 'function') {
    const waitUntil = ctx.waitUntil.bind(ctx);
    out.waitUntil = (promise) => waitUntil(promise);
  }
  const cf = (request as Request & { cf?: unknown }).cf;
  if (cf && typeof cf === 'object') out.cf = cf as GeoProperties;
  return out;
}

/** The handler options of a wrapped entry (everything but the entry-specific parts). */
export function handlerFor(options: WrapOptions): HypHandler {
  const { config, manifest, host, ...rest } = options;
  return createHandler({ ...rest, config, manifest, host: host ?? HOST_LABEL });
}

/**
 * Runs the Drivetrain around the entry's `fetch`: internal routes (`/_hypdriv/*`), the HTTPS upgrade, security
 * headers, the CSP, rate limits, the bot shield, geo, flags, redirects, maintenance mode, logging and
 * `Server-Timing` around everything Waku answers (pages, RSC payloads, server functions, API routes, static
 * files). The pipeline's forwarded request (sanitised headers, the stages' `x-hypdriv-*` headers) is what Waku
 * receives.
 */
export function wrapFetch(
  fetch: WakuServerEntry['fetch'],
  handler: HypHandler,
  after?: (request: Request, response: Response) => Promise<Response> | Response,
): WakuServerEntry['fetch'] {
  return (request, ...args) =>
    handler(request, {
      ...platformInput(request, args, handler.config),
      upstream: async (forwarded) => {
        const response = await fetch(forwarded, ...args);
        return after ? after(forwarded, response) : response;
      },
    });
}

/** The entry with its `fetch` behind the Drivetrain (build, build enhancers and the rest are Waku's). */
export function wrapEntry(entry: WakuServerEntry, options: WrapOptions): WakuServerEntry {
  return { ...entry, fetch: wrapFetch(entry.fetch, handlerFor(options)) };
}
