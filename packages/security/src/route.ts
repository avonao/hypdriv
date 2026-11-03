import { base64UrlEncode, clientIp, createRequestId, digest, mergeHeaders, problem } from '@hypdriv/core';
import {
  ActionError,
  enforceInlineRateLimit,
  formDataToObject,
  type InlineRateLimit,
  inlinePolicy,
  isNextNavigationError,
} from './actions';
import { rateLimitHeaders } from './rate-limit/headers';
import { createRateLimiter } from './rate-limit/limiter';
import { createMemoryCounterStore } from './rate-limit/stores';
import type { RateLimiter, RateLimitResult } from './rate-limit/types';
import { type StandardSchemaV1, validateWithSchema } from './standard-schema';

/** Context handed to a route handler. */
export interface RouteContext<Query = unknown, Body = unknown, Auth = unknown> {
  request: Request;
  url: URL;
  /** Dynamic segment params from Next (`context.params`, awaited). */
  params: Record<string, string>;
  query: Query;
  body: Body;
  auth: Auth;
  ip: string;
  headers: Headers;
  requestId: string;
  signal: AbortSignal;
  /** The raw second argument Next passed. */
  raw: unknown;
}

/** CORS settings of a route. */
export interface RouteCors {
  /** Allowed origins (`*`, exact origins or `https://*.example.com`). */
  origins: string[];
  methods?: string[];
  headers?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  /** Preflight cache in seconds (default 600). */
  maxAge?: number;
}

/** Definition passed to `defineRoute`. */
export interface RouteDefinition<Query, Body, Output, Auth = unknown> {
  name?: string;
  /** Allowed methods (default: any). `HEAD` is implied by `GET`. */
  method?: string | string[];
  query?: StandardSchemaV1<unknown, Query>;
  body?: StandardSchemaV1<unknown, Body>;
  auth?: (ctx: RouteContext<Query, Body, null>) => Promise<Auth | null> | Auth | null;
  /** Inline rate limit; the key defaults to the client IP. */
  rateLimit?: Omit<InlineRateLimit<RouteContext<Query, Body, Auth>>, 'key'> & {
    key?: (ctx: RouteContext<Query, Body, Auth>) => string;
  };
  limiter?: RateLimiter;
  /** `Cache-Control` for JSON results (`public|private, max-age, stale-while-revalidate`). Default `no-store`. */
  cache?: { maxAge: number; swr?: number; private?: boolean };
  /** Weak ETag + `304` for JSON results on GET/HEAD (default true). */
  etag?: boolean;
  cors?: RouteCors;
  /** Reject bodies above this many bytes (by `Content-Length`). Default 1 MiB when a body schema is set. */
  maxBodyBytes?: number;
  handler: (ctx: RouteContext<Query, Body, Auth>) => Promise<Response | Output> | Response | Output;
  onError?: (
    error: unknown,
    ctx: RouteContext<Query | undefined, Body | undefined, Auth | null>,
  ) => void | Promise<void>;
}

/** The fetch-style handler returned by `defineRoute` (usable as a Next.js Route Handler export). */
export type RouteHandler = (request: Request, context?: unknown) => Promise<Response>;

let defaultLimiter: RateLimiter | undefined;

/** `URLSearchParams` → object; repeated keys become arrays. */
export function parseQuery(params: URLSearchParams): Record<string, string | string[]> {
  // no prototype: a `__proto__` key is data, not a way to replace the object's prototype
  const out = Object.create(null) as Record<string, string | string[]>;
  for (const [key, value] of params.entries()) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** Weak ETag of a body: `W/"<first 27 chars of base64url(sha256)>"`. */
export async function weakEtag(body: string | Uint8Array): Promise<string> {
  return `W/"${base64UrlEncode(await digest(body)).slice(0, 27)}"`;
}

/** `If-None-Match` evaluation (weak comparison; handles lists and `*`). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const strip = (v: string) => v.trim().replace(/^W\//i, '');
  if (ifNoneMatch.trim() === '*') return true;
  const target = strip(etag);
  return ifNoneMatch.split(',').some((candidate) => strip(candidate) === target);
}

function originAllowed(origin: string, allowed: string[]): boolean {
  for (const entry of allowed) {
    if (entry === '*' || entry === origin) return true;
    if (entry.includes('*')) {
      const re = new RegExp(`^${entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+')}$`, 'i');
      if (re.test(origin)) return true;
    }
  }
  return false;
}

/** CORS response headers for a request origin (empty when the origin is not allowed). */
export function corsHeaders(
  cors: RouteCors,
  requestOrigin: string | null,
  preflight: Request | null,
): Record<string, string> {
  if (!requestOrigin || !originAllowed(requestOrigin, cors.origins)) return {};
  const wildcard = cors.origins.includes('*') && !cors.credentials;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': wildcard ? '*' : requestOrigin,
    Vary: 'Origin',
  };
  if (cors.credentials) headers['Access-Control-Allow-Credentials'] = 'true';
  if (cors.exposeHeaders?.length) headers['Access-Control-Expose-Headers'] = cors.exposeHeaders.join(', ');
  if (preflight) {
    headers['Access-Control-Allow-Methods'] = (
      cors.methods ?? ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    ).join(', ');
    const requested = preflight.headers.get('access-control-request-headers');
    const allowHeaders =
      cors.headers ??
      (requested
        ? requested
            .split(',')
            .map((h) => h.trim())
            .filter(Boolean)
        : []);
    if (allowHeaders.length) headers['Access-Control-Allow-Headers'] = allowHeaders.join(', ');
    headers['Access-Control-Max-Age'] = String(cors.maxAge ?? 600);
  }
  return headers;
}

function cacheControlFor(cache: RouteDefinition<unknown, unknown, unknown>['cache']): string {
  if (!cache) return 'no-store';
  let v = `${cache.private ? 'private' : 'public'}, max-age=${Math.max(0, Math.floor(cache.maxAge))}`;
  if (cache.swr) v += `, stale-while-revalidate=${Math.max(0, Math.floor(cache.swr))}`;
  return v;
}

/** Renders an `ActionError` as `application/problem+json`. */
export function problemFromActionError(
  error: ActionError,
  extraHeaders: Record<string, string> = {},
): Response {
  const extra: Record<string, unknown> = { code: error.code };
  if (error.fieldErrors) extra.errors = error.fieldErrors;
  const res = problem(error.status, error.code, error.message, extra);
  const headers = new Headers(res.headers);
  mergeHeaders(headers, extraHeaders);
  if (error.retryAfter !== undefined && !headers.has('retry-after'))
    headers.set('retry-after', String(error.retryAfter));
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

async function resolveParams(context: unknown): Promise<Record<string, string>> {
  if (!context || typeof context !== 'object') return {};
  const params = await (context as { params?: unknown }).params;
  if (!params || typeof params !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>))
    out[k] = Array.isArray(v) ? v.join('/') : String(v);
  return out;
}

async function readBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new ActionError('VALIDATION', 'Request body too large', { status: 413 });
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('application/json') || type.endsWith('+json')) {
    const text = await request.text();
    if (text.length > maxBytes)
      throw new ActionError('VALIDATION', 'Request body too large', { status: 413 });
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ActionError('VALIDATION', 'Invalid JSON body');
    }
  }
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data'))
    return formDataToObject(await request.formData());
  const text = await request.text();
  if (text.length > maxBytes) throw new ActionError('VALIDATION', 'Request body too large', { status: 413 });
  return text.length ? text : undefined;
}

/**
 * Defines a validated, authenticated, rate-limited Route Handler with CORS, ETag/304 and caching
 * helpers. Non-`Response` results are serialised as JSON; `ActionError`s become problem+json; Next.js
 * navigation errors propagate.
 */
export function defineRoute<Query = unknown, Body = unknown, Output = unknown, Auth = unknown>(
  definition: RouteDefinition<Query, Body, Output, Auth>,
): RouteHandler {
  const name = definition.name ?? 'route';
  const methods = definition.method
    ? (Array.isArray(definition.method) ? definition.method : [definition.method]).map((m) => m.toUpperCase())
    : null;
  if (methods?.includes('GET') && !methods.includes('HEAD')) methods.push('HEAD');
  const policy = definition.rateLimit ? inlinePolicy(`route:${name}`, definition.rateLimit) : null;
  const maxBody = definition.maxBodyBytes ?? 1024 * 1024;

  return async (request, context) => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const origin = request.headers.get('origin');
    const cors = definition.cors ? corsHeaders(definition.cors, origin, null) : {};
    const finish = (res: Response, extra: Record<string, string> = {}): Response => {
      const merged = { ...cors, ...extra };
      if (!Object.keys(merged).length) return res;
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(merged))
        if (k.toLowerCase() === 'vary') mergeHeaders(headers, { vary: v });
        else if (!headers.has(k)) headers.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    };

    if (definition.cors && method === 'OPTIONS' && request.headers.has('access-control-request-method')) {
      const preflight = corsHeaders(definition.cors, origin, request);
      return new Response(null, {
        status: 204,
        headers: Object.keys(preflight).length ? preflight : { 'content-length': '0' },
      });
    }
    if (methods && !methods.includes(method)) {
      return finish(problem(405, 'METHOD_NOT_ALLOWED', `Method ${method} is not allowed`), {
        Allow: methods.join(', '),
      });
    }

    const ctx: RouteContext<Query | undefined, Body | undefined, Auth | null> = {
      request,
      url,
      params: {},
      query: undefined,
      body: undefined,
      auth: null,
      ip: clientIp(request.headers),
      headers: request.headers,
      requestId:
        request.headers.get('x-request-id') ??
        request.headers.get('x-hypdriv-request-id') ??
        createRequestId(),
      signal: request.signal,
      raw: context,
    };
    let rateLimit: RateLimitResult | null = null;

    try {
      ctx.params = await resolveParams(context);
      if (definition.query) {
        const validated = await validateWithSchema(definition.query, parseQuery(url.searchParams));
        if (!validated.ok)
          throw new ActionError('VALIDATION', validated.message, { fieldErrors: validated.fieldErrors });
        ctx.query = validated.value;
      } else ctx.query = parseQuery(url.searchParams) as Query;

      if (definition.body && method !== 'GET' && method !== 'HEAD') {
        const raw = await readBody(request, maxBody);
        const validated = await validateWithSchema(definition.body, raw);
        if (!validated.ok)
          throw new ActionError('VALIDATION', validated.message, { fieldErrors: validated.fieldErrors });
        ctx.body = validated.value;
      }

      if (definition.auth) {
        const principal = await definition.auth(ctx as RouteContext<Query, Body, null>);
        if (principal === null || principal === undefined) throw new ActionError('UNAUTHORIZED');
        ctx.auth = principal;
      }
      const full = ctx as RouteContext<Query, Body, Auth>;

      if (policy && definition.rateLimit) {
        defaultLimiter ??= createRateLimiter({ store: createMemoryCounterStore() });
        const key = definition.rateLimit.key ? definition.rateLimit.key(full) : full.ip;
        rateLimit = await enforceInlineRateLimit(definition.limiter ?? defaultLimiter, policy, key);
      }

      const result = await definition.handler(full);
      const rlHeaders = rateLimit && policy ? rateLimitHeaders(rateLimit, policy.id) : {};
      if (result instanceof Response) return finish(result, rlHeaders);
      if (result === undefined || result === null)
        return finish(new Response(null, { status: 204 }), rlHeaders);

      const text = JSON.stringify(result);
      const headers: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': cacheControlFor(definition.cache),
        ...rlHeaders,
      };
      if (definition.etag !== false && (method === 'GET' || method === 'HEAD')) {
        const etag = await weakEtag(text);
        headers.etag = etag;
        if (etagMatches(request.headers.get('if-none-match'), etag))
          return finish(new Response(null, { status: 304, headers }));
      }
      return finish(new Response(method === 'HEAD' ? null : text, { status: 200, headers }));
    } catch (error) {
      if (isNextNavigationError(error)) throw error;
      const actionError = ActionError.from(error);
      if (actionError.code === 'INTERNAL' || !(error instanceof ActionError)) {
        try {
          await definition.onError?.(error, ctx);
        } catch {
          // error hooks never affect the response
        }
      }
      const extra: Record<string, string> = {};
      if (actionError.code === 'RATE_LIMITED' && actionError.retryAfter !== undefined)
        extra['Retry-After'] = String(actionError.retryAfter);
      return finish(problemFromActionError(actionError, extra));
    }
  };
}
