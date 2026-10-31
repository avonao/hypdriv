import {
  createConsoleLogger,
  type FlagDefinition,
  type FlagValue,
  getCurrentContext,
  HEADER,
  type HypContext,
  type HypDrivEnv,
  type Logger,
  parseCookies,
} from '@hypdriv/core';
import { decodeFlagsHeader, encodeFlagsHeader, publicFlags } from '@hypdriv/flags';
import { decodeThemeHeader, resolveTheme } from '@hypdriv/purser';
import {
  createJobHandler,
  decodeGeoHeader,
  type GeoInfo,
  type JobHandlerOptions,
  type JobInput,
} from '@hypdriv/runtime';

export { defineRoute, type ServerActionContext, safeAction } from './actions';
export { HypDrivMeta, Speculation, ThemeScript } from './components';

/** Request-scoped information Hypdriv makes available to Server Components, Route Handlers and Server Actions. */
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
  runner: 'worker' | 'proxy' | 'host' | 'node' | 'test' | null;
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
  /** The full pipeline context when running inside the Hypdriv Worker. */
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
 * The Hypdriv request context. Works on the Worker (full pipeline context), on `next start` behind
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

export type { JobHandlerOptions, JobInput } from '@hypdriv/runtime';

/**
 * Wraps a Route Handler so it only accepts signed internal requests from the Worker's `scheduled`,
 * `queue` and `email` handlers (or from `hypdriv jobs run`), and Vercel Cron calls authenticated with
 * `CRON_SECRET`. Export it as both `GET` (Vercel Cron) and `POST` (Cloudflare dispatch).
 */
export function jobHandler(
  options: JobHandlerOptions,
  handler: (input: JobInput) => Promise<Response | unknown>,
): (request: Request) => Promise<Response> {
  return createJobHandler({ context: () => hyp() }, options, handler);
}

/**
 * Request facts Hypdriv's `<HypDrivMeta/>` renders for the DevTools HUD (safe to expose to the browser).
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
