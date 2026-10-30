import {
  type FlagValue,
  HEADER,
  type HypContext,
  type HypDrivEnv,
  HypDrivError,
  type Logger,
  createConsoleLogger,
  getCurrentContext,
  parseCookies,
} from '@hypdriv/core';
import { decodeFlagsHeader } from '@hypdriv/flags';
import { signing } from '@hypdriv/security';
import { type GeoInfo, decodeGeoHeader } from '../stages/geo';

export { Speculation, HypDrivMeta } from './components';
export { safeAction, defineRoute, type ServerActionContext } from './actions';

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
export function setCloudflareContextLoader(loader: (() => Promise<CloudflareContextLike | null>) | null): void {
  cloudflareContextLoader = loader;
}

async function cloudflareContext(): Promise<CloudflareContextLike | null> {
  if (cloudflareContextLoader) return cloudflareContextLoader();
  try {
    const mod = (await import('@opennextjs/cloudflare')) as { getCloudflareContext?: (options: { async: true }) => Promise<CloudflareContextLike> };
    if (!mod.getCloudflareContext) return null;
    return await mod.getCloudflareContext({ async: true });
  } catch {
    return null;
  }
}

async function requestHeaders(): Promise<Headers> {
  const current = getCurrentContext();
  if (current) return current.requestHeaders;
  const mod = (await import('next/headers')) as { headers(): Promise<Headers> | Headers };
  return new Headers(await mod.headers());
}

async function afterFn(): Promise<((task: Promise<unknown> | (() => Promise<unknown>)) => void) | null> {
  try {
    const mod = (await import('next/server')) as { after?: (task: Promise<unknown> | (() => Promise<unknown>)) => void };
    return mod.after ?? null;
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
  const themeHeader = headers.get(HEADER.theme);
  const theme = themeHeader ? Object.fromEntries(themeHeader.split(';').filter(Boolean).map((kv) => kv.split('=') as [string, string])) : null;
  const log = pipeline?.log ?? createConsoleLogger({ fields: { requestId: headers.get(HEADER.hypRequestId) ?? undefined } });

  const flag = ((name: string, fallback?: FlagValue) => (name in flags ? flags[name] : fallback)) as HypServerContext['flag'];

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
    runner: (headers.get(HEADER.runner) as HypServerContext['runner']) ?? (pipeline?.runner ?? null),
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
  /** Accept requests without a signature in development (default true). */
  allowUnsignedInDevelopment?: boolean;
  ttlSeconds?: number;
}

/**
 * Wraps a Route Handler so it only accepts signed internal requests from the Worker's `scheduled`,
 * `queue` and `email` handlers (or from `hypdriv jobs run`).
 */
export function jobHandler(options: JobHandlerOptions, handler: (input: JobInput) => Promise<Response | unknown>): (request: Request) => Promise<Response> {
  const secretEnv = options.secretEnv ?? 'HYPDRIV_INTERNAL_SECRET';
  return async (request) => {
    const context = await hyp();
    const secret = (context.env[secretEnv] as string | undefined) ?? processEnv()[secretEnv];
    const development = processEnv().NODE_ENV === 'development';
    if (!secret) {
      if (!(development && options.allowUnsignedInDevelopment !== false)) {
        return Response.json({ error: 'internal_secret_missing', hint: `set ${secretEnv}` }, { status: 503 });
      }
    } else {
      const ok = await signing.verifyInternalRequest(request.clone(), secret, { ttlSeconds: options.ttlSeconds ?? 300 });
      if (!ok) return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    let payload: unknown = null;
    let job = request.headers.get('x-hypdriv-job') ?? new URL(request.url).searchParams.get('job') ?? 'default';
    let cron: string | undefined;
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
      const result = await handler({ request, job, payload, ...(cron ? { cron } : {}), ...(messages ? { messages } : {}) });
      if (result instanceof Response) return result;
      return Response.json({ ok: true, job, result: result ?? null });
    } catch (err) {
      const e = err instanceof HypDrivError ? err : new HypDrivError('E_INTERNAL', (err as Error).message);
      context.log.error('job failed', { job, error: e.message });
      return Response.json({ ok: false, job, error: e.code, message: e.message }, { status: e.status });
    }
  };
}

/** Request headers HypDriv's `<HypDrivMeta/>` renders for DevTools (safe to expose to the browser). */
export async function devtoolsMeta(): Promise<Record<string, string>> {
  const h = await requestHeaders();
  const out: Record<string, string> = {};
  const id = h.get(HEADER.hypRequestId);
  if (id) out['hypdriv:request'] = id;
  const flags = h.get(HEADER.flags);
  if (flags) out['hypdriv:flags'] = flags;
  const locale = h.get(HEADER.locale);
  if (locale) out['hypdriv:locale'] = locale;
  const runner = h.get(HEADER.runner);
  if (runner) out['hypdriv:runner'] = runner;
  const route = h.get(HEADER.route);
  if (route) out['hypdriv:route'] = route;
  return out;
}
