import {
  createConsoleLogger,
  type FlagDefinition,
  type FlagValue,
  getCurrentContext,
  HEADER,
  type HypContext,
  type HypDrivEnv,
  HypDrivError,
  type Logger,
  parseCookies,
  timingSafeEqual,
} from '@hypdriv/core';
import { decodeFlagsHeader, encodeFlagsHeader, publicFlags } from '@hypdriv/flags';
import { decodeThemeHeader, resolveTheme } from '@hypdriv/purser';
import { signing } from '@hypdriv/security';
import { decodeGeoHeader, type GeoInfo } from '../stages/geo';

export { defineRoute, type ServerActionContext, safeAction } from './actions';
export { HypDrivMeta, Speculation, ThemeScript } from './components';

/** Request-scoped information HypDriv makes available to Server Components, Route Handlers and Server Actions. */
export interface HypServerContext {
  requestId: string | null;
  nonce: string | null;
  geo: Partial<GeoInfo> | null;
  country: string | null;
  locale: string | null;
  flags: Record<string, FlagValue>;
  theme: Record<string, string> | null;
  cspMode: string | null;
  speculation: 'edge' | 'component' | null;
  runner: 'worker' | 'proxy' | 'node' | 'test' | null;
  /** The incoming request headers (read-only). */
  headers: Headers;
  cookies: Record<string, string>;
  /** Worker bindings/environment (Cloudflare) or `process.env`. */
  env: HypDrivEnv;
  cf: Record<string, unknown> | undefined;
  /** Runs work after the response is sent (`ctx.waitUntil` on Workers, `after()` elsewhere). */
  waitUntil(promise: Promise<unknown>): void;
  flag<T extends FlagValue>(name: string, fallback: T): T;
  flag(name: string): FlagValue | undefined;
  log: Logger;
  /** The full pipeline context when running inside the HypDriv Worker. */
  pipeline: HypContext | undefined;
}

interface CloudflareContextLike {
  env: Record<string, unknown>;
  cf: Record<string, unknown> | undefined;
  ctx: { waitUntil(promise: Promise<unknown>): void };
}

let cloudflareContextLoader: (() => Promise<CloudflareContextLike | null>) | null = null;

/** Allows the Worker shell (or tests) to supply the Cloudflare context accessor without a hard dependency. */
export function setCloudflareContextLoader(
  loader: (() => Promise<CloudflareContextLike | null>) | null,
): void {
  cloudflareContextLoader = loader;
}

/**
 * OpenNext publishes the per-request `{ env, ctx, cf }` on this global symbol (in the Worker entry and,
 * in `next dev`, through `initOpenNextCloudflareForDev()`); reading it avoids a hard dependency on
 * `@opennextjs/cloudflare` so the same code runs on plain Node hosts.
 */
const CLOUDFLARE_CONTEXT = Symbol.for('__cloudflare-context__');

async function cloudflareContext(): Promise<CloudflareContextLike | null> {
  if (cloudflareContextLoader) return cloudflareContextLoader();
  const value = (globalThis as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT];
  return value && typeof value === 'object' && 'env' in value ? (value as CloudflareContextLike) : null;
}

async function requestHeaders(): Promise<Headers> {
  const current = getCurrentContext();
  if (current) return current.requestHeaders;
  const mod = (await import('next/headers')) as { headers(): Promise<Headers> | Headers };
  return new Headers(await mod.headers());
}

async function afterFn(): Promise<((task: Promise<unknown> | (() => Promise<unknown>)) => void) | null> {
  try {
    const mod = (await import('next/server')) as {
      after?: (task: Promise<unknown> | (() => Promise<unknown>)) => void;
    };
    return mod.after ?? null;
  } catch {
    return null;
  }
}

/**
 * The theme selection: the `x-hypdriv-theme` header forwarded by the `theme` stage, or (for RSC
 * navigations, which skip that stage) resolved from cookies/client hints when the config is at hand.
 */
function themeFor(headers: Headers, pipeline: HypContext | undefined): Record<string, string> | null {
  const decoded = decodeThemeHeader(headers.get(HEADER.theme));
  if (Object.keys(decoded).length) return decoded;
  const config = pipeline?.config.purser?.theme;
  if (!config) return null;
  try {
    return resolveTheme(config, { cookies: parseCookies(headers.get('cookie')), headers }).values;
  } catch {
    return null;
  }
}

const processEnv = (): HypDrivEnv => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return (p?.env ?? {}) as HypDrivEnv;
};

/**
 * The HypDriv request context. Works on the Worker (full pipeline context), on `next start` behind
 * `proxy.ts` (headers forwarded by the stages) and in `next dev`.
 */
export async function hyp(): Promise<HypServerContext> {
  const pipeline = getCurrentContext();
  const headers = await requestHeaders();
  const cfCtx = pipeline ? null : await cloudflareContext();
  const env = (pipeline?.env ?? cfCtx?.env ?? processEnv()) as HypDrivEnv;
  const after = pipeline || cfCtx ? null : await afterFn();
  const geo = decodeGeoHeader(headers.get(HEADER.geo));
  const flags = decodeFlagsHeader(headers.get(HEADER.flags));
  const theme = themeFor(headers, pipeline);
  const log =
    pipeline?.log ??
    createConsoleLogger({ fields: { requestId: headers.get(HEADER.hypRequestId) ?? undefined } });

  const flag = ((name: string, fallback?: FlagValue) =>
    name in flags ? flags[name] : fallback) as HypServerContext['flag'];

  return {
    requestId: headers.get(HEADER.hypRequestId) ?? headers.get(HEADER.requestId),
    nonce: headers.get(HEADER.nonce),
    geo,
    country: geo?.country ?? headers.get('x-hypdriv-country') ?? headers.get('cf-ipcountry'),
    locale: headers.get(HEADER.locale),
    flags,
    theme,
    cspMode: headers.get(HEADER.cspMode),
    speculation: (headers.get('x-hypdriv-speculation') as 'edge' | 'component' | null) ?? null,
    runner: (headers.get(HEADER.runner) as HypServerContext['runner']) ?? pipeline?.runner ?? null,
    headers,
    cookies: parseCookies(headers.get('cookie')),
    env,
    cf: pipeline?.cf ?? cfCtx?.cf,
    waitUntil(promise) {
      if (pipeline) return pipeline.waitUntil(promise);
      if (cfCtx) return cfCtx.ctx.waitUntil(promise);
      if (after) return after(promise);
      void promise.catch(() => undefined);
    },
    flag,
    log,
    pipeline,
  };
}

/** The CSP nonce for the current request (nonce mode), for third-party `<script nonce>` tags. */
export async function nonce(): Promise<string | undefined> {
  return (await requestHeaders()).get(HEADER.nonce) ?? undefined;
}

/** Geo information for the current request. */
export async function geo(): Promise<Partial<GeoInfo>> {
  const h = await requestHeaders();
  return decodeGeoHeader(h.get(HEADER.geo)) ?? { country: h.get('cf-ipcountry') ?? null };
}

/** Reads an edge-evaluated feature flag. */
export async function flag<T extends FlagValue>(name: string, fallback: T): Promise<T>;
export async function flag(name: string): Promise<FlagValue | undefined>;
export async function flag(name: string, fallback?: FlagValue): Promise<FlagValue | undefined> {
  const values = decodeFlagsHeader((await requestHeaders()).get(HEADER.flags));
  return name in values ? values[name] : fallback;
}

/** Schedules work after the response: Workers `waitUntil` when available, else Next's `after()`. */
export function defer(task: () => Promise<unknown>): void {
  const pipeline = getCurrentContext();
  if (pipeline) {
    pipeline.waitUntil(task());
    return;
  }
  void afterFn().then((after) => {
    if (after) after(task);
    else void task().catch(() => undefined);
  });
}

export interface JobInput {
  request: Request;
  /** Job name from the payload (cron jobs) or queue name. */
  job: string;
  payload: unknown;
  /** Cron expression when triggered by a schedule. */
  cron?: string;
  /** Queue message metadata when triggered by a queue batch. */
  messages?: Array<{ id: string; timestamp: string; body: unknown; attempts: number }>;
}

export interface JobHandlerOptions {
  /** Environment variable holding the shared secret (default `HYPDRIV_INTERNAL_SECRET`). */
  secretEnv?: string;
  /**
   * Environment variable holding the secret Vercel Cron sends as `Authorization: Bearer <secret>`
   * (default `CRON_SECRET`). Requests carrying it are accepted as cron invocations.
   */
  cronSecretEnv?: string;
  /** Job name reported to the handler when the request does not name one (Vercel Cron calls). */
  job?: string;
  /** Accept requests without a signature in development (default true). */
  allowUnsignedInDevelopment?: boolean;
  ttlSeconds?: number;
}

/**
 * Wraps a Route Handler so it only accepts signed internal requests from the Worker's `scheduled`,
 * `queue` and `email` handlers (or from `hypdriv jobs run`), and Vercel Cron calls authenticated with
 * `CRON_SECRET`. Export it as both `GET` (Vercel Cron) and `POST` (Cloudflare dispatch).
 */
export function jobHandler(
  options: JobHandlerOptions,
  handler: (input: JobInput) => Promise<Response | unknown>,
): (request: Request) => Promise<Response> {
  const secretEnv = options.secretEnv ?? 'HYPDRIV_INTERNAL_SECRET';
  const cronSecretEnv = options.cronSecretEnv ?? 'CRON_SECRET';
  return async (request) => {
    const context = await hyp();
    const readSecret = (name: string) => {
      const value = context.env[name] ?? processEnv()[name];
      return typeof value === 'string' && value ? value : undefined;
    };
    const secret = readSecret(secretEnv);
    const cronSecret = readSecret(cronSecretEnv);
    const development = processEnv().NODE_ENV === 'development';
    // Vercel Cron: GET with `Authorization: Bearer $CRON_SECRET` (compared in constant time).
    const authorization = request.headers.get('authorization');
    const viaVercelCron = !!cronSecret && !!authorization && timingSafeEqual(authorization, `Bearer ${cronSecret}`);
    if (!viaVercelCron) {
      if (!secret) {
        if (!(development && options.allowUnsignedInDevelopment !== false)) {
          return Response.json({ error: 'internal_secret_missing', hint: `set ${secretEnv} (or ${cronSecretEnv} for Vercel Cron)` }, { status: 503 });
        }
      } else {
        const ok = await signing.verifyInternalRequest(request.clone() as Request, secret, {
          ttlSeconds: options.ttlSeconds ?? 300,
        });
        if (!ok) return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
    }
    let payload: unknown = null;
    let job =
      request.headers.get('x-hypdriv-job') ??
      new URL(request.url).searchParams.get('job') ??
      options.job ??
      new URL(request.url).pathname.split('/').filter(Boolean).pop() ??
      'default';
    let cron: string | undefined = viaVercelCron ? (request.headers.get('x-vercel-cron-schedule') ?? undefined) : undefined;
    let messages: JobInput['messages'];
    if (request.method !== 'GET' && request.headers.get('content-type')?.includes('application/json')) {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        payload = body.payload ?? body;
        if (typeof body.job === 'string') job = body.job;
        if (typeof body.cron === 'string') cron = body.cron;
        if (Array.isArray(body.messages)) messages = body.messages as JobInput['messages'];
      } catch {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
      }
    }
    try {
      const result = await handler({
        request,
        job,
        payload,
        ...(cron ? { cron } : {}),
        ...(messages ? { messages } : {}),
      });
      if (result instanceof Response) return result;
      return Response.json({ ok: true, job, result: result ?? null });
    } catch (err) {
      const e = err instanceof HypDrivError ? err : new HypDrivError('E_INTERNAL', (err as Error).message);
      context.log.error('job failed', { job, error: e.message });
      return Response.json({ ok: false, job, error: e.code, message: e.message }, { status: e.status });
    }
  };
}

/**
 * Request facts HypDriv's `<HypDrivMeta/>` renders for the DevTools HUD (safe to expose to the browser).
 * Flags are filtered through `publicFlags`, so `serverOnly` definitions never reach the page; without the
 * flag definitions (no pipeline context and none passed) flags are omitted rather than risk a leak.
 */
export async function devtoolsMeta(
  options: { flagDefinitions?: Record<string, FlagDefinition> } = {},
): Promise<Record<string, string>> {
  const h = await requestHeaders();
  const out: Record<string, string> = {};
  const id = h.get(HEADER.hypRequestId);
  if (id) out['hypdriv:request'] = id;
  const definitions = options.flagDefinitions ?? getCurrentContext()?.config.flags.definitions;
  const rawFlags = h.get(HEADER.flags);
  if (rawFlags && definitions) {
    const visible = publicFlags(decodeFlagsHeader(rawFlags), definitions);
    if (Object.keys(visible).length) out['hypdriv:flags'] = encodeFlagsHeader(visible);
  }
  const locale = h.get(HEADER.locale);
  if (locale) out['hypdriv:locale'] = locale;
  const runner = h.get(HEADER.runner);
  if (runner) out['hypdriv:runner'] = runner;
  const route = h.get(HEADER.route);
  if (route) out['hypdriv:route'] = route;
  return out;
}
