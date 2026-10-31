import {
  type GeoProperties,
  getCurrentContext,
  type HypDrivConfig,
  type HypDrivEnv,
  type HypManifest,
  type ResolvedConfig,
} from '@hypdriv/core';
import {
  type CreateHandlerOptions,
  createHandler,
  type HandleInput,
  type HypHandler,
  type HypRequestContext,
  hyp,
  type ManifestSource,
} from '@hypdriv/runtime';
import {
  createContext,
  createRequestHandler,
  type MiddlewareFunction,
  type RouterContext,
  RouterContextProvider,
  type ServerBuild,
} from 'react-router';
import { dataRedirect, withDataRequests } from './data-requests';
import { HOST, isPrerenderRequest, isRedirect } from './shared';

/**
 * `@hypdriv/react-router/server` — the HypDriv runtime for React Router: the root `middleware`, the server entry
 * that wraps the whole request handler (Node, Vercel), router-context keys and the request helpers application
 * code uses (`hyp()`, `nonce()`, `flag()`, `geo()`, `defer()`, `jobHandler()`).
 */
export {
  defer,
  flag,
  geo,
  type HypRequestContext,
  hyp,
  type JobHandlerOptions,
  type JobInput,
  jobHandler,
  nonce,
  requireHyp,
} from '@hypdriv/runtime';
export {
  dataRedirect,
  dataRequestVariants,
  isDataRequest,
  withDataRequests,
  withDataVariants,
} from './data-requests';
export { isPrerenderRequest, PRERENDER_HEADER } from './shared';

/** The HypDriv request context in React Router's router context: `context.get(hypdrivContext)` in loaders. */
export const hypdrivContext: RouterContext<HypRequestContext | null> =
  createContext<HypRequestContext | null>(null);

/** What HypDriv's Cloudflare Worker entry puts into the router context of each request. */
export interface CloudflareRequestContext<Env = Record<string, unknown>> {
  env: Env;
  ctx: { waitUntil(promise: Promise<unknown>): void; passThroughOnException?(): void };
  cf: Record<string, unknown> | undefined;
}

/** Cloudflare bindings, execution context and `request.cf` of the request (set by `reactRouterWorker()`). */
export const cloudflareContext: RouterContext<CloudflareRequestContext | null> =
  createContext<CloudflareRequestContext | null>(null);

/** Platform facts for the pipeline when React Router's own server hands over only the request. */
export interface PlatformInput {
  env?: HypDrivEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
  cf?: GeoProperties;
  ip?: string;
}

type HandlerOptions = Pick<CreateHandlerOptions, 'stages' | 'onError' | 'development' | 'target' | 'skip'>;

export interface HypDrivMiddlewareOptions extends HandlerOptions {
  /** The HypDriv config (default: `virtual:hypdriv/config`, served by the HypDriv Vite plugin). */
  config?: HypDrivConfig | ResolvedConfig;
  /** The build manifest (default: `virtual:hypdriv/manifest`). */
  manifest?: ManifestSource;
  /** The build's prerender token (default: `virtual:hypdriv/react-router`). */
  prerenderToken?: string;
  /** Platform values from the router context (custom servers that pass them through `getLoadContext`). */
  platform?: (args: {
    request: Request;
    context: Readonly<RouterContextProvider>;
  }) => PlatformInput | undefined | Promise<PlatformInput | undefined>;
}

interface LoadedRuntime {
  handler: HypHandler;
  prerenderToken: string;
}

async function virtualConfig(): Promise<HypDrivConfig> {
  const mod = (await import('virtual:hypdriv/config')) as { default: HypDrivConfig };
  return mod.default;
}

async function virtualToken(): Promise<string> {
  try {
    const mod = (await import('virtual:hypdriv/react-router')) as { prerenderToken?: string };
    return typeof mod.prerenderToken === 'string' ? mod.prerenderToken : '';
  } catch {
    return '';
  }
}

function handlerOptions(options: HandlerOptions): HandlerOptions {
  const out: HandlerOptions = {};
  if (options.stages) out.stages = options.stages;
  if (options.onError) out.onError = options.onError;
  if (options.development !== undefined) out.development = options.development;
  if (options.target) out.target = options.target;
  if (options.skip) out.skip = options.skip;
  return out;
}

/** Lazily creates the HypDriv handler (config, manifest and token load on the first request). */
function runtimeLoader(options: {
  config?: HypDrivConfig | ResolvedConfig | undefined;
  manifest?: ManifestSource | undefined;
  prerenderToken?: string | undefined;
  handler: HandlerOptions;
}): () => Promise<LoadedRuntime> {
  let pending: Promise<LoadedRuntime> | null = null;
  return () => {
    pending ??= (async () => {
      const [config, prerenderToken] = await Promise.all([
        options.config ?? virtualConfig(),
        options.prerenderToken ?? virtualToken(),
      ]);
      const manifest: ManifestSource =
        options.manifest !== undefined
          ? options.manifest
          : () => import('virtual:hypdriv/manifest') as Promise<{ default: HypManifest }>;
      const handler = createHandler({
        config: withDataRequests(config),
        manifest,
        host: HOST,
        ...handlerOptions(options.handler),
      });
      return { handler, prerenderToken };
    })().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

function withPlatform(input: PlatformInput | undefined): Omit<HandleInput, 'upstream'> {
  const out: Omit<HandleInput, 'upstream'> = {};
  if (!input) return out;
  if (input.env) out.env = input.env;
  if (input.waitUntil) out.waitUntil = input.waitUntil;
  if (input.cf) out.cf = input.cf;
  if (input.ip) out.ip = input.ip;
  return out;
}

/**
 * The root route `middleware` that runs the HypDriv Drivetrain around every request React Router answers with a
 * route — documents, `.data` requests, actions and resource routes — in development and production on every
 * platform. Inside an outer HypDriv runner (the Cloudflare Worker entry, the Node server, Vercel functions) the
 * stages already ran and it only exposes the request context; during the build's prerendering it stays out of the
 * way, so prerendered HTML carries no per-request data.
 *
 * ```ts
 * // app/root.tsx
 * import { hypdrivMiddleware } from '@hypdriv/react-router/server';
 * export const middleware = [hypdrivMiddleware()];
 * ```
 *
 * Responses the pipeline answers itself (rate limits, bot blocks, maintenance) reach `.data` requests as errors for
 * the nearest `ErrorBoundary`; its redirects are thrown, so React Router turns them into client-side redirects.
 */
export function hypdrivMiddleware(options: HypDrivMiddlewareOptions = {}): MiddlewareFunction<Response> {
  const runtime = runtimeLoader({
    config: options.config,
    manifest: options.manifest,
    prerenderToken: options.prerenderToken,
    handler: options,
  });
  const expose = (context: Readonly<RouterContextProvider>) => {
    context.set(hypdrivContext, hyp());
  };
  return async ({ request, context }, next) => {
    const current = getCurrentContext();
    if (current && (current.runner === 'worker' || current.runner === 'host')) {
      expose(context);
      return next();
    }
    const { handler, prerenderToken } = await runtime();
    if (isPrerenderRequest(request, prerenderToken)) return next();
    const platform = options.platform ? await options.platform({ request, context }) : undefined;
    let rendered: Promise<Response> | null = null;
    const response = await handler(request, {
      ...withPlatform(platform),
      upstream: () => {
        if (rendered)
          throw new Error(
            'hypdriv: the React Router middleware renders a request once; background revalidation needs an outer HypDriv runner',
          );
        expose(context);
        rendered = Promise.resolve(next());
        return rendered;
      },
    });
    // A redirect the pipeline answered itself (redirect rules, HTTPS upgrade, i18n): thrown, React Router turns it
    // into a single-fetch redirect for `.data` requests.
    if (!rendered && isRedirect(response)) throw response;
    return response;
  };
}

/** Per-request input of `HypDrivServer.fetch`. */
export interface ServerFetchInput extends PlatformInput {
  /** Serves static files (the client build) before React Router; `null` falls through. */
  assets?: (request: Request) => Promise<Response | null> | Response | null;
  /** Fills the router context of the request (platform values for loaders). */
  context?: (request: Request, context: RouterContextProvider) => void | Promise<void>;
}

/** HypDriv around a React Router server build: one full-response handler for every request. */
export interface HypDrivServer {
  /** Answers a request: the pipeline around the static files (when given) and React Router. */
  fetch(request: Request, input?: ServerFetchInput): Promise<Response>;
  /** The HypDriv handler (config, manifest, runtime). */
  handler(): Promise<HypHandler>;
  /** The React Router server build. */
  build(): Promise<ServerBuild>;
}

export interface ServerEntryOptions extends HandlerOptions {
  /** The React Router server build (`virtual:react-router/server-build`) or a loader of it. */
  build: ServerBuild | (() => ServerBuild | Promise<ServerBuild>);
  /** The HypDriv config (default: `virtual:hypdriv/config`). */
  config?: HypDrivConfig | ResolvedConfig;
  /** The build manifest (default: `virtual:hypdriv/manifest`). */
  manifest?: ManifestSource;
  /** The build's prerender token (default: `virtual:hypdriv/react-router`). */
  prerenderToken?: string;
  /** React Router's server mode (default: `NODE_ENV`, else `production`). */
  mode?: string;
  /** Fills the router context of every request. */
  getLoadContext?: (request: Request, context: RouterContextProvider) => void | Promise<void>;
}

function serverMode(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NODE_ENV === 'development' ? 'development' : 'production';
}

function isBuildModule(value: unknown): value is ServerBuild {
  return typeof value === 'object' && value !== null && 'routes' in value && 'entry' in value;
}

/**
 * Creates the HypDriv server entry of a React Router build: `fetch(request)` runs the pipeline around the whole
 * request handler — every route, 404s, 405s, `/__manifest` and (with `assets`) the static files — and the root
 * middleware passes through inside it. HypDriv's Vite plugin makes it the SSR entry of Node and Vercel builds
 * (`build/server/index.js` exports it as `hypdriv`, and its `fetch` as the default export).
 */
export function createServerEntry(options: ServerEntryOptions): HypDrivServer {
  const runtime = runtimeLoader({
    config: options.config,
    manifest: options.manifest,
    prerenderToken: options.prerenderToken,
    handler: options,
  });
  let buildPromise: Promise<ServerBuild> | null = null;
  const loadBuild = (): Promise<ServerBuild> => {
    buildPromise ??= Promise.resolve(typeof options.build === 'function' ? options.build() : options.build)
      .then((b) => (isBuildModule(b) ? b : ((b as { default?: ServerBuild }).default ?? b)) as ServerBuild)
      .catch((err: unknown) => {
        buildPromise = null;
        throw err;
      });
    return buildPromise;
  };
  const requestHandler = createRequestHandler(loadBuild, options.mode ?? serverMode());

  return {
    async fetch(request, input = {}) {
      const { handler, prerenderToken } = await runtime();
      const render = async (forwarded: Request): Promise<Response> => {
        if (input.assets && (forwarded.method === 'GET' || forwarded.method === 'HEAD')) {
          const asset = await input.assets(forwarded);
          if (asset) return asset;
        }
        const context = new RouterContextProvider();
        await options.getLoadContext?.(forwarded, context);
        await input.context?.(forwarded, context);
        return requestHandler(forwarded, context);
      };
      if (isPrerenderRequest(request, prerenderToken)) return render(request);
      const response = await handler(request, { ...withPlatform(input), upstream: render });
      // React Router answers data requests' redirects itself (single fetch); the pipeline's own need converting.
      return dataRedirect(request, response);
    },
    async handler() {
      return (await runtime()).handler;
    },
    build: loadBuild,
  };
}
