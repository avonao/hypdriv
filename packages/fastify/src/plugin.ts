import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { type HypDrivConfig, type HypManifest, normalizeIp, type ResolvedConfig } from '@hypdriv/core';
import {
  type CreateHandlerOptions,
  createHandler,
  type HypHandler,
  isStaticRequest,
  type ManifestSource,
  REVALIDATE_HEADER,
  nonce as requestNonce,
} from '@hypdriv/runtime';
import {
  appRequestHeaders,
  bridgeRequest,
  remoteAddress,
  syncRequestHeaders,
  withAssetHeaders,
} from '@hypdriv/runtime/node';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import fp from 'fastify-plugin';
import { applyResponse, HOP_BY_HOP, payloadResponse } from './response';
import { fastifyManifest, routesFromTree } from './routes';

/** The label reported in logs and `/_hypdriv/health`. */
export const HOST_LABEL = 'fastify';

/** What `fastify.hypdriv` gives back: the handler behind the plugin and the manifest it derived. */
export interface HypDrivFastifyDecoration {
  readonly handler: HypHandler;
  /** The route manifest as of now (the routes registered so far plus the `routes` option). */
  manifest(): HypManifest;
  /** What about the registration order defeats the Drivetrain (also logged when the plugin loads). */
  readonly warnings: readonly string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The request's CSP nonce (nonce mode), for `<script nonce>` tags the app renders itself; `null` otherwise. */
    hypdrivNonce: string | null;
  }
  interface FastifyInstance {
    hypdriv: HypDrivFastifyDecoration;
  }
}

export interface HypDrivFastifyOptions extends Omit<CreateHandlerOptions, 'config' | 'manifest' | 'host'> {
  /** The Hypdriv config (`defineConfig({...})`). */
  config: HypDrivConfig | ResolvedConfig;
  /** A manifest, or a loader; default: derived from the routes the app registers (`fastifyManifest`). */
  manifest?: ManifestSource;
  /** The framework label (default `fastify`). */
  host?: string;
  /** More route patterns for the derived manifest: see `fastifyManifest`. */
  routes?: readonly string[];
  /**
   * Trust `x-forwarded-proto` / `x-forwarded-host` for the request URL (a reverse proxy in front of the server).
   * Default: on when `security.trustedProxies > 0`, on Vercel, or with `HYPDRIV_TRUST_PROXY=1`.
   */
  trustProxy?: boolean;
  /** The public origin of the site (`https://example.com`), when the `Host` header cannot be trusted. */
  origin?: string;
  /**
   * Static-file responses (the requests `skip` keeps out of the stages: `@fastify/static`) get the security header
   * preset of the config. Default `true`.
   */
  staticHeaders?: boolean;
}

type Env = Record<string, string | undefined>;

const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/** The header that marks a request `fastify.inject()` made for background revalidation (value: a per-process secret). */
const DETACHED_HEADER = 'x-hypdriv-detached';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Rejections are handled by whoever awaits; a request that never gets there must not crash the process.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * Where a request is on its way through the Drivetrain.
 * - `pending`: the stages before the app are running.
 * - `proceeded`: they let the request through; Fastify runs the route, `onSend` hands the response back.
 * - `answered`: a stage answered itself (a rate limit, the HTTPS upgrade, an internal route); the route never ran.
 * - `failed`: the pipeline broke before the app; the error went to Fastify's error handler.
 * - `settled`: the route's response was handed to the pipeline, or the connection ended without one.
 */
type Phase = 'pending' | 'proceeded' | 'answered' | 'failed' | 'settled';

interface Flow {
  phase: Phase;
  /** The route's response, for the pipeline's `upstream`. */
  app: Deferred<Response>;
  /** The pipeline's final response, for `onSend`. */
  final: Deferred<Response>;
}

function validStatus(status: number): number {
  return Number.isInteger(status) && status >= 200 && status <= 599 ? status : 200;
}

/**
 * The Drivetrain as a Fastify plugin: security headers, the CSP with a per-request nonce, rate limits, the bot
 * shield, geo, flags, redirects, maintenance mode, Early Hints, logging, `Server-Timing` and `/_hypdriv/*` around
 * every route, static file, not-found response and error of the instance — built on `createHandler`
 * (`runner: 'host'`) and Fastify's request lifecycle:
 *
 * - `onRequest` bridges the Node request to a Web `Request` (its body stays unread until a stage asks for it, and
 *   goes back to Fastify's content-type parsers afterwards), runs the stages before the route and either answers
 *   itself or lets the request on;
 * - `onSend` hands what the route answered to the stages after it and sends their final response, streaming.
 *
 * The plugin breaks Fastify's encapsulation (`fastify-plugin`): its hooks cover routes registered in any child
 * context, before or after it. Register it first, so hooks of other plugins (an auth check that replies early) do
 * not answer without it.
 *
 * ```ts
 * await app.register(hypdriv, { config });
 * ```
 */
export const hypdriv = fp<HypDrivFastifyOptions>(
  async (fastify: FastifyInstance, options) => {
    const {
      config,
      manifest,
      host,
      routes: extraRoutes,
      trustProxy,
      origin,
      staticHeaders = true,
      skip: userSkip,
      ...rest
    } = options;
    const skip = userSkip ?? ((url: URL) => isStaticRequest(url));

    // `onRoute` sees the routes registered after this plugin loaded; the ones before it come from the router's tree.
    const urls = new Set<string>();
    try {
      for (const url of routesFromTree(fastify.printRoutes())) urls.add(url);
    } catch {
      // The router is not readable yet: only the routes registered from here on are discovered.
    }
    fastify.addHook('onRoute', (route) => {
      urls.add(route.url);
    });
    const derive = (): HypManifest =>
      fastifyManifest(urls, { version: fastify.version, ...(extraRoutes ? { routes: extraRoutes } : {}) });

    const handler = createHandler({
      ...rest,
      config,
      manifest: manifest ?? derive,
      host: host ?? HOST_LABEL,
      skip,
    });
    const env = processEnv();
    const trust = (): boolean =>
      trustProxy ??
      (handler.config.security.trustedProxies > 0 || env.HYPDRIV_TRUST_PROXY === '1' || env.VERCEL === '1');
    // The socket address is the client only when nothing sits in front of the server: behind a proxy (or on Vercel,
    // whose proxy is the peer) the forwarded headers decide, according to `security.trustedProxies`.
    const useSocketAddress = (): boolean =>
      handler.config.security.trustedProxies === 0 && env.VERCEL !== '1';

    const token = randomUUID();
    const flows = new WeakMap<FastifyRequest, Flow>();

    // `@fastify/compress` compresses in `onSend`, in registration order: registered before this plugin, it hands the
    // pipeline a gzip body that a CSP nonce cannot be injected into.
    const warnings: string[] = [];
    if (fastify.hasPlugin('@fastify/compress'))
      warnings.push(
        '@fastify/compress is registered before @hypdriv/fastify: it compresses the response before the Drivetrain reads it, so CSP nonces cannot be injected into the HTML. Register hypdriv first.',
      );
    for (const warning of warnings) fastify.log.warn(warning);

    fastify.decorateRequest('hypdrivNonce', null);
    fastify.decorate('hypdriv', { handler, manifest: derive, warnings } satisfies HypDrivFastifyDecoration);

    /** Renders a request through the app again, without the Drivetrain: stale-while-revalidate's background call. */
    const revalidate = async (forwarded: Request, address: string | undefined): Promise<Response> => {
      const url = new URL(forwarded.url);
      const headers: Record<string, string> = {};
      forwarded.headers.forEach((value, name) => {
        headers[name] = value;
      });
      headers[DETACHED_HEADER] = token;
      const injected = await fastify.inject({
        method: forwarded.method as HTTPMethods,
        url: `${url.pathname}${url.search}`,
        headers,
        ...(address ? { remoteAddress: address } : {}),
        ...(forwarded.body ? { payload: Readable.fromWeb(forwarded.body as never) } : {}),
      });
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(injected.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        if (Array.isArray(value)) for (const v of value) responseHeaders.append(name, v);
        else responseHeaders.set(name, String(value));
      }
      const empty = [204, 205, 304].includes(injected.statusCode) || injected.rawPayload.length === 0;
      return new Response(empty ? null : new Uint8Array(injected.rawPayload), {
        status: validStatus(injected.statusCode),
        headers: responseHeaders,
      });
    };

    fastify.addHook(
      'onRequest',
      (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void) => {
        const marker = request.raw.headers[DETACHED_HEADER];
        if (marker !== undefined) {
          // Nothing but the plugin's own revalidation may carry this header; either way it never reaches the app.
          delete request.raw.headers[DETACHED_HEADER];
          if (marker === token) return done();
        }
        let bridged: ReturnType<typeof bridgeRequest>;
        try {
          bridged = bridgeRequest(request.raw, { trustProxy: trust(), ...(origin ? { origin } : {}) });
        } catch (error) {
          return done(error instanceof Error ? error : new Error(String(error)));
        }
        const method = request.raw.method?.toUpperCase() ?? 'GET';
        const flow: Flow = { phase: 'pending', app: deferred<Response>(), final: deferred<Response>() };
        flows.set(request, flow);
        // The client went away before the response was complete; a reply written to the socket directly
        // (`reply.hijack()`, websockets) never reaches `onSend`, so the pipeline gets an empty stand-in for it.
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) bridged.abort(new Error('client disconnected'));
          if (flow.phase === 'proceeded') {
            flow.phase = 'settled';
            flow.app.resolve(new Response(null, { status: validStatus(reply.raw.statusCode) }));
          }
        });
        const address = remoteAddress(request.raw);
        handler(bridged.request, {
          ...(address && useSocketAddress() ? { ip: normalizeIp(address) } : {}),
          upstream: async (forwarded) => {
            if (forwarded.headers.has(REVALIDATE_HEADER)) return revalidate(forwarded, address);
            const asset = skip(new URL(forwarded.url), forwarded);
            // Fastify's content-type parsers read the body from the Node request: put back whatever a stage took from
            // it, and let the route see the pipeline's request headers (the client's x-hypdriv-* gone, the stages' in).
            bridged.body?.release();
            const current = requestNonce();
            syncRequestHeaders(request.raw, appRequestHeaders(forwarded.headers, current));
            request.hypdrivNonce = current ?? null;
            flow.phase = 'proceeded';
            // From here on Fastify runs the route inside this request's Drivetrain context (`hyp()`, `nonce()`).
            done();
            const answered = await flow.app.promise;
            return asset && staticHeaders
              ? withAssetHeaders(handler.config, forwarded, answered, {
                  development: env.NODE_ENV === 'development',
                })
              : answered;
          },
        }).then(
          (final) => {
            if (flow.phase === 'proceeded' || flow.phase === 'settled') flow.final.resolve(final);
            else if (flow.phase === 'pending') {
              flow.phase = 'answered';
              if (!reply.sent) void reply.send(applyResponse(reply, final, method));
            }
          },
          (error) => {
            if (flow.phase === 'proceeded' || flow.phase === 'settled') flow.final.reject(error);
            else if (flow.phase === 'pending') {
              flow.phase = 'failed';
              done(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );
      },
    );

    fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      const flow = flows.get(request);
      if (flow?.phase !== 'proceeded') return payload;
      flow.phase = 'settled';
      const method = request.raw.method?.toUpperCase() ?? 'GET';
      let response: Response;
      try {
        response = payloadResponse(reply, method, payload);
      } catch (error) {
        // A status or payload the Web `Response` refuses: the route's own response goes out as it is.
        flow.app.reject(error);
        return payload;
      }
      flow.app.resolve(response);
      return applyResponse(reply, await flow.final.promise, method);
    });
  },
  { name: '@hypdriv/fastify', fastify: '5.x' },
);
