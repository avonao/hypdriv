import { clientConnFor, type HypDrivRuntimeOptions, handlerFor, type WrapOptions } from './entry';
import {
  createQwikFetch,
  errorResponse,
  isStaticPath,
  notFoundResponse,
  type QwikFetchOptions,
} from './fetch';

/** Vercel's skew protection pins a browser to its deployment with this cookie. */
export const VERCEL_SKEW_COOKIE = '__vdpl';

/** The context Vercel hands a Web handler (`@vercel/functions`' `waitUntil`). */
export interface VercelRequestContext {
  waitUntil?(promise: Promise<unknown>): void;
}

/** The Vercel function a Qwik entry exports: a Web `Request` → `Response` handler. */
export type HypDrivQwikVercelHandler = (
  request: Request,
  context?: VercelRequestContext,
) => Promise<Response>;

export interface QwikRouterVercelOptions extends QwikFetchOptions {
  hypdriv?: HypDrivRuntimeOptions;
}

type Env = Record<string, string | undefined>;

const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/**
 * Qwik Router's request handler as a Vercel Node.js function behind the Drivetrain. The function runs the pipeline
 * for every request that reaches it (pages rendered on demand, loaders, actions, endpoints); prerendered pages the
 * CDN serves get Hypdriv's Routing Middleware and static header rules from the Vite plugin. Like Qwik's own Vercel
 * adapter it sets the skew-protection cookie when Vercel's skew protection is on.
 */
export function wrapVercel(qwik: QwikFetchOptions, options: WrapOptions): HypDrivQwikVercelHandler {
  const handler = handlerFor(options);
  const qwikFetch = createQwikFetch(qwik);
  return async (request, context) => {
    const env = processEnv();
    const upstream = async (forwarded: Request): Promise<Response> => {
      try {
        // A static file the CDN did not find (the filesystem is checked first) is a 404, never a render.
        if (isStaticPath(forwarded.method, new URL(forwarded.url))) return notFoundResponse(forwarded);
        const response = await qwikFetch(forwarded, {
          env: (key) => env[key],
          platform: { request: forwarded },
          clientConn: (req) => clientConnFor(req, { ip: 'x-real-ip', country: 'x-vercel-ip-country' }),
        });
        if (!response) return notFoundResponse(forwarded);
        return withSkewCookie(forwarded, response, env);
      } catch (error) {
        return errorResponse(error, 'vercel');
      }
    };
    return handler(request, {
      upstream,
      ...(context?.waitUntil ? { waitUntil: (promise) => context.waitUntil?.(promise) } : {}),
    });
  };
}

/** Qwik's skew-protection behaviour: a navigation sets `__vdpl=<deployment id>` when skew protection is enabled. */
export function withSkewCookie(request: Request, response: Response, env: Env): Response {
  if (!env.VERCEL_SKEW_PROTECTION_ENABLED || !request.headers.has('sec-fetch-dest')) return response;
  const path = env.BASE_URL || '/';
  const out = new Response(response.body, response);
  out.headers.append(
    'set-cookie',
    `${VERCEL_SKEW_COOKIE}=${encodeURIComponent(env.VERCEL_DEPLOYMENT_ID || '')}; Path=${path}; Secure; SameSite=Strict; HttpOnly`,
  );
  return out;
}
