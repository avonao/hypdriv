import {
  type DeployTarget,
  type GeoProperties,
  getCurrentContext,
  type HypContext,
  type HypDrivConfig,
  platformWaitUntil,
  type ResolvedConfig,
  type Stage,
} from '@hypdriv/core';
import {
  type CreateHandlerOptions,
  createHandler,
  type HandleInput,
  type HypHandler,
  type ManifestSource,
  type StageList,
} from '@hypdriv/runtime';

/**
 * Stages whose `pre` decides about or counts the request — rate limits (local and Vercel WAF), the bot shield, the
 * request shield and CSRF. They run once per HTTP request: when Astro renders its error page through the middleware
 * a second time for the same request (a render that threw → `500.astro`, an empty 404/500 response → the error
 * page), these stages are skipped on that second pass.
 */
export const ONCE_PER_REQUEST_STAGES: ReadonlySet<string> = new Set([
  'shield',
  'bots',
  'rate-limit',
  'rate-limit-vercel',
  'csrf',
]);

type WaitUntil = (promise: Promise<unknown>) => void;

/** `waitUntil` functions handed to the error-page pass; the pipeline context carries the one it was given. */
const errorPagePasses = new WeakSet<WaitUntil>();

/** Whether a pipeline context belongs to Astro's error-page pass of a request whose first pass already ran. */
export function isErrorPagePass(ctx: Pick<HypContext, 'waitUntil'>): boolean {
  return errorPagePasses.has(ctx.waitUntil);
}

function oncePerRequest(stage: Stage): Stage {
  const { pre, post } = stage;
  return {
    ...stage,
    ...(pre ? { pre: (ctx: HypContext) => (isErrorPagePass(ctx) ? undefined : pre.call(stage, ctx)) } : {}),
    ...(post
      ? {
          post: (ctx: HypContext, response: Response) =>
            isErrorPagePass(ctx) ? response : post.call(stage, ctx, response),
        }
      : {}),
  };
}

export interface AstroHandlerOptions {
  config: HypDrivConfig | ResolvedConfig;
  manifest?: ManifestSource;
  /** `astro dev`. */
  development?: boolean;
  /** The platform the build targets (from the Astro adapter); detected when omitted. */
  target?: DeployTarget | null;
  /** Customise the stage list (the once-per-request guard is applied on top). */
  stages?: StageList;
  /** Extra `createHandler` options (platform overrides for tests and custom hosts). */
  platform?: CreateHandlerOptions['platform'];
}

/**
 * The HypDriv handler behind the Astro hooks: `createHandler()` with the `astro` host label, the build's target and
 * the once-per-request guard on the gating stages.
 */
export function createAstroHandler(options: AstroHandlerOptions): HypHandler {
  return createHandler({
    config: options.config,
    ...(options.manifest !== undefined ? { manifest: options.manifest } : {}),
    host: 'astro',
    ...(options.development !== undefined ? { development: options.development } : {}),
    ...(options.target ? { target: options.target } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    stages: (defaults, platform) => {
      const list =
        typeof options.stages === 'function'
          ? options.stages(defaults, platform)
          : (options.stages ?? defaults);
      return list.map((stage) => (ONCE_PER_REQUEST_STAGES.has(stage.name) ? oncePerRequest(stage) : stage));
    },
  });
}

/** The parts of Astro's `APIContext` the hook reads (structural, so the hook is testable without Astro). */
export interface AstroContextLike {
  request: Request;
  /** The matched route is prerendered (`export const prerender = true`). */
  isPrerendered: boolean;
  locals: object;
  /** Astro's client address; the getter throws where the adapter provides none. */
  readonly clientAddress: string;
}

/** Astro's `next()`: renders the route, or rewrites to another one when given a path, URL or request. */
export type AstroNext = (rewritePayload?: string | URL | Request) => Promise<Response>;

/** What the hook passes to the handler besides the request: Cloudflare's `waitUntil` and `cf`, the client IP. */
export function platformInput(context: AstroContextLike): Omit<HandleInput, 'upstream'> {
  const input: Omit<HandleInput, 'upstream'> = {};
  // Cloudflare: `locals.cfContext` is the Worker's ExecutionContext (`locals.runtime` is a throwing trap in Astro 6+).
  const cfContext = (context.locals as { cfContext?: { waitUntil?: WaitUntil } } | undefined)?.cfContext;
  if (cfContext && typeof cfContext.waitUntil === 'function') {
    const waitUntil = cfContext.waitUntil;
    input.waitUntil = (promise) => waitUntil.call(cfContext, promise);
  }
  const cf = (context.request as { cf?: GeoProperties }).cf;
  if (cf && typeof cf === 'object') input.cf = cf;
  try {
    const ip = context.clientAddress;
    if (typeof ip === 'string' && ip) input.ip = ip;
  } catch {
    // No client address on this adapter/request: the handler reads the forwarded headers.
  }
  return input;
}

/** Calls Astro's `next()`, rewriting only when a stage changed the target of the forwarded request. */
export function forwardTo(next: AstroNext, original: Request, forwarded: Request): Promise<Response> {
  if (forwarded === original || forwarded.url === original.url) return next();
  const target = new URL(forwarded.url);
  return next(`${target.pathname}${target.search}`);
}

/** Response headers that describe the body they were sent with (the error page brings its own). */
const BODY_POLICY_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-hypdriv-csp',
] as const;

interface FirstPass {
  response: Response | null;
}

export interface AstroHookOptions {
  handler: HypHandler;
  /** This bundle renders build-time prerenders (Astro's `prerender` environment). */
  prerendering: boolean;
  /** `astro dev`: prerendered routes render per request and run the pipeline. */
  development: boolean;
}

/**
 * Creates Astro's `onRequest` middleware that runs the HypDriv Drivetrain around the rest of the request (`next()`):
 *
 * - **Build-time prerendering passes through.** The bundle Astro prerenders with is a separate Vite environment
 *   whose `virtual:hypdriv/astro` says `prerendering: true`; a prerendered route can only render at build time in
 *   production (`context.isPrerendered` comes from the route table, not from the request). Neither can be set by
 *   a client.
 * - **Outer HypDriv runners pass through**: inside the Cloudflare Worker shell (`createWorker`), a `src/fetch.ts`
 *   wrapped with `withHypDriv()`, and for rewrites Astro renders inside the same request.
 * - **Astro's error-page pass** (a render that threw → `500.astro`, an empty 404/500 response → the error page) runs
 *   the response stages again for the error page, without the rate limit, bot shield, request shield and CSRF
 *   stages: they already ran for this request.
 */
export function createOnRequest(options: AstroHookOptions) {
  const firstPasses = new WeakMap<Request, FirstPass>();
  return async function onRequest(context: AstroContextLike, next: AstroNext): Promise<Response> {
    if (options.prerendering || (context.isPrerendered && !options.development)) return next();
    if (getCurrentContext()) return next();
    const request = context.request;
    const input = platformInput(context);
    const earlier = firstPasses.get(request);
    if (earlier) {
      const base =
        input.waitUntil ?? platformWaitUntil() ?? ((p: Promise<unknown>) => void p.catch(() => {}));
      const waitUntil: WaitUntil = (promise) => base(promise);
      errorPagePasses.add(waitUntil);
      input.waitUntil = waitUntil;
      // Astro merges the first response's headers over the error page's: its policy described the empty body.
      if (earlier.response) {
        for (const name of BODY_POLICY_HEADERS) {
          try {
            earlier.response.headers.delete(name);
          } catch {
            // immutable headers: the error page keeps the first response's policy
          }
        }
      }
    }
    const pass: FirstPass = { response: null };
    if (!earlier) firstPasses.set(request, pass);
    const response = await options.handler(request, {
      ...input,
      upstream: (forwarded) => forwardTo(next, request, forwarded),
    });
    if (!earlier) pass.response = response;
    return response;
  };
}
