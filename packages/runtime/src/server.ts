import {
  createConsoleLogger,
  type FlagDefinition,
  type FlagValue,
  getCurrentContext,
  getRuntime,
  HEADER,
  type HypContext,
  type HypDrivEnv,
  HypDrivError,
  type Logger,
  parseCookies,
  platformWaitUntil,
  timingSafeEqual,
} from '@hypdriv/core';
import { decodeFlagsHeader, encodeFlagsHeader, publicFlags } from '@hypdriv/flags';
import { decodeThemeHeader, resolveTheme } from '@hypdriv/purser';
import { signing } from '@hypdriv/security';
import { decodeGeoHeader, type GeoInfo } from './stages/geo';

/**
 * Request-scoped information HypDriv makes available to application code running below a HypDriv handler
 * (framework hooks, `createHandler`, the Worker shell): loaders, endpoints, server functions, components.
 */
export interface HypRequestContext {
  requestId: string;
  /** The CSP nonce of the request (nonce mode), for `<script nonce>` tags the application renders itself. */
  nonce: string | null;
  geo: Partial<GeoInfo> | null;
  country: string | null;
  locale: string | null;
  flags: Record<string, FlagValue>;
  theme: Record<string, string> | null;
  cspMode: string | null;
  speculation: 'edge' | 'component' | null;
  runner: HypContext['runner'];
  /** The matched manifest route id. */
  route: string | null;
  /** The request headers as forwarded to the application (sanitised, plus the stages' `x-hypdriv-*` headers). */
  headers: Headers;
  cookies: Record<string, string>;
  /** Cloudflare bindings or `process.env` (platform-augmented on Vercel). */
  env: HypDrivEnv;
  cf: Record<string, unknown> | undefined;
  /** Keeps work alive after the response (`ctx.waitUntil` on Workers, Vercel's `waitUntil`). */
  waitUntil(promise: Promise<unknown>): void;
  flag<T extends FlagValue>(name: string, fallback: T): T;
  flag(name: string): FlagValue | undefined;
  log: Logger;
  /** The full pipeline context. */
  pipeline: HypContext;
}

const processEnv = (): HypDrivEnv =>
  ((globalThis as { process?: { env?: HypDrivEnv } }).process?.env ?? {}) as HypDrivEnv;

function themeFor(ctx: HypContext): Record<string, string> | null {
  const decoded = decodeThemeHeader(ctx.requestHeaders.get(HEADER.theme));
  if (Object.keys(decoded).length) return decoded;
  const theme = ctx.config.purser?.theme;
  if (!theme) return null;
  try {
    return resolveTheme(theme, {
      cookies: parseCookies(ctx.requestHeaders.get('cookie')),
      headers: ctx.requestHeaders,
    }).values;
  } catch {
    return null;
  }
}

/** Builds the request context view from a pipeline context. */
export function requestContextFrom(ctx: HypContext): HypRequestContext {
  const headers = ctx.requestHeaders;
  const geo = decodeGeoHeader(headers.get(HEADER.geo));
  const flags = decodeFlagsHeader(headers.get(HEADER.flags));
  const flag = ((name: string, fallback?: FlagValue) =>
    name in flags ? flags[name] : fallback) as HypRequestContext['flag'];
  return {
    requestId: ctx.id,
    nonce: headers.get(ctx.config.security.csp?.nonceHeader ?? HEADER.nonce),
    geo,
    country: geo?.country ?? null,
    locale: headers.get(HEADER.locale),
    flags,
    theme: themeFor(ctx),
    cspMode: headers.get(HEADER.cspMode),
    speculation: (headers.get('x-hypdriv-speculation') as 'edge' | 'component' | null) ?? null,
    runner: ctx.runner,
    route: ctx.route?.route.id ?? null,
    headers,
    cookies: parseCookies(headers.get('cookie')),
    env: ctx.env as HypDrivEnv,
    cf: ctx.cf as Record<string, unknown> | undefined,
    waitUntil: (promise) => ctx.waitUntil(promise),
    flag,
    log: ctx.log,
    pipeline: ctx,
  };
}

/**
 * The HypDriv request context of the current request, or `null` outside one (build-time prerendering, code
 * that runs outside a request). Synchronous: framework hooks run the application inside the context.
 */
export function hyp(): HypRequestContext | null {
  const ctx = getCurrentContext();
  return ctx ? requestContextFrom(ctx) : null;
}

/** Like `hyp()`, but throws when called outside a HypDriv request. */
export function requireHyp(): HypRequestContext {
  const context = hyp();
  if (!context)
    throw new HypDrivError(
      'E_UNSUPPORTED',
      'hyp(): no HypDriv request context; is the HypDriv hook installed and the call inside a request?',
    );
  return context;
}

/** The CSP nonce for the current request (nonce mode), for third-party `<script nonce>` tags. */
export function nonce(): string | undefined {
  return hyp()?.nonce ?? undefined;
}

/** Reads an edge-evaluated feature flag of the current request. */
export function flag<T extends FlagValue>(name: string, fallback: T): T;
export function flag(name: string): FlagValue | undefined;
export function flag(name: string, fallback?: FlagValue): FlagValue | undefined {
  const flags = hyp()?.flags ?? {};
  return name in flags ? flags[name] : fallback;
}

/** Geo information for the current request. */
export function geo(): Partial<GeoInfo> {
  return hyp()?.geo ?? {};
}

/** Schedules work after the response (`waitUntil` of the request, else the platform's, else fire-and-forget). */
export function defer(task: () => Promise<unknown>): void {
  const ctx = getCurrentContext();
  if (ctx) {
    ctx.waitUntil(task());
    return;
  }
  const waitUntil = platformWaitUntil();
  const promise = task().catch(() => undefined);
  if (waitUntil) waitUntil(promise);
}

/**
 * Request facts for the DevTools HUD's `<meta name="hypdriv:*">` tags (safe to expose): server-only flags are
 * filtered through `publicFlags`.
 */
export function devtoolsMeta(
  options: { flagDefinitions?: Record<string, FlagDefinition> } = {},
): Record<string, string> {
  const ctx = getCurrentContext();
  if (!ctx) return {};
  const h = ctx.requestHeaders;
  const out: Record<string, string> = { 'hypdriv:request': ctx.id, 'hypdriv:runner': ctx.runner };
  const definitions = options.flagDefinitions ?? ctx.config.flags.definitions;
  const rawFlags = h.get(HEADER.flags);
  if (rawFlags && definitions) {
    const visible = publicFlags(decodeFlagsHeader(rawFlags), definitions);
    if (Object.keys(visible).length) out['hypdriv:flags'] = encodeFlagsHeader(visible);
  }
  const locale = h.get(HEADER.locale);
  if (locale) out['hypdriv:locale'] = locale;
  if (ctx.route) out['hypdriv:route'] = ctx.route.route.id;
  return out;
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
  /** Environment variable holding the shared secret (default `security.internalAuth.secretEnv`, else `HYPDRIV_INTERNAL_SECRET`). */
  secretEnv?: string;
  /** Environment variable holding Vercel Cron's bearer secret (default `vercel.cronSecretEnv`, else `CRON_SECRET`). */
  cronSecretEnv?: string;
  /** Job name reported to the handler when the request does not name one (Vercel Cron calls). */
  job?: string;
  /** Accept requests without a signature in development (default true). */
  allowUnsignedInDevelopment?: boolean;
  ttlSeconds?: number;
}

/** What `createJobHandler` needs from the host: the environment and a logger for the current request. */
export interface JobHandlerHost {
  context(): Promise<{ env: HypDrivEnv; log: Logger }> | { env: HypDrivEnv; log: Logger };
}

/**
 * The host-independent core of `jobHandler`: accepts only signed internal requests (Cloudflare `scheduled` /
 * `queue` / `email` dispatch, `hypdriv jobs run`) and Vercel Cron calls carrying `CRON_SECRET`.
 */
export function createJobHandler(
  host: JobHandlerHost,
  options: JobHandlerOptions,
  handler: (input: JobInput) => Promise<Response | unknown>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const config = getCurrentContext()?.config ?? getRuntime()?.config;
    const secretEnv =
      options.secretEnv ?? config?.security.internalAuth.secretEnv ?? 'HYPDRIV_INTERNAL_SECRET';
    const cronSecretEnv = options.cronSecretEnv ?? config?.vercel.cronSecretEnv ?? 'CRON_SECRET';
    const context = await host.context();
    const readSecret = (name: string) => {
      const value = context.env[name] ?? processEnv()[name];
      return typeof value === 'string' && value ? value : undefined;
    };
    const secret = readSecret(secretEnv);
    const cronSecret = readSecret(cronSecretEnv);
    const development = processEnv().NODE_ENV === 'development';
    const authorization = request.headers.get('authorization');
    const viaVercelCron =
      !!cronSecret && !!authorization && timingSafeEqual(authorization, `Bearer ${cronSecret}`);
    if (!viaVercelCron) {
      if (!secret) {
        if (!(development && options.allowUnsignedInDevelopment !== false)) {
          return Response.json(
            {
              error: 'internal_secret_missing',
              hint: `set ${secretEnv} (or ${cronSecretEnv} for Vercel Cron)`,
            },
            { status: 503 },
          );
        }
      } else {
        const ok = await signing.verifyInternalRequest(request.clone() as Request, secret, {
          ttlSeconds: options.ttlSeconds ?? 300,
        });
        if (!ok) return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
    }
    let payload: unknown = null;
    const url = new URL(request.url);
    const configured = viaVercelCron
      ? Object.entries(config?.jobs.cron ?? {}).find(([, entry]) => entry.path === url.pathname)
      : undefined;
    let job =
      request.headers.get('x-hypdriv-job') ??
      url.searchParams.get('job') ??
      options.job ??
      configured?.[0] ??
      url.pathname.split('/').filter(Boolean).pop() ??
      'default';
    let cron: string | undefined = viaVercelCron
      ? (request.headers.get('x-vercel-cron-schedule') ?? configured?.[1].cron ?? undefined)
      : undefined;
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
 * Wraps an endpoint so it only accepts HypDriv's signed job dispatch and Vercel Cron (see
 * `createJobHandler`). Mount it on the path `jobs.cron` / `jobs.queues` point at.
 */
export function jobHandler(
  options: JobHandlerOptions,
  handler: (input: JobInput) => Promise<Response | unknown>,
): (request: Request) => Promise<Response> {
  return createJobHandler(
    {
      context() {
        const ctx = getCurrentContext();
        return {
          env: (ctx?.env as HypDrivEnv | undefined) ?? getRuntime()?.env ?? processEnv(),
          log: ctx?.log ?? createConsoleLogger({ fields: { component: 'hypdriv-jobs' } }),
        };
      },
    },
    options,
    handler,
  );
}
