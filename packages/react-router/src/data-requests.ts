import type { HypDrivConfig, ResolvedConfig, RoutePattern } from '@hypdriv/core';
import { isRedirect } from './shared';

/**
 * React Router fetches a route's data and submits its actions through `<path>.data` (`/_root.data` and `/_.data` for
 * the index, `<path>/_.data` for paths with a trailing slash). A rule written for `/login` must cover `/login.data`
 * too, or client-side navigations and form submissions would bypass it.
 */

/** Whether a request is a React Router data request (`.data` suffix). */
export function isDataRequest(request: Request | URL): boolean {
  const url = request instanceof URL ? request : new URL(request.url);
  return url.pathname.endsWith('.data');
}

/** The data-request spellings a path pattern also covers (none for regular expressions and search patterns). */
export function dataRequestVariants(pattern: string): string[] {
  if (pattern.startsWith('^') || pattern.includes('\\?')) return [];
  if (pattern === '/' || pattern === '') return ['/_root.data', '/_.data'];
  if (pattern.endsWith('/**')) {
    const base = pattern.slice(0, -3);
    return base ? [`${base}.data`] : [];
  }
  // A trailing `*` already matches `.data` within the segment.
  if (pattern.endsWith('*')) return [];
  const trimmed = pattern.replace(/\/+$/, '');
  return [`${trimmed}.data`, `${trimmed}/_.data`];
}

/** A route pattern extended with its data-request spellings. */
export function withDataVariants(pattern: RoutePattern): RoutePattern;
export function withDataVariants(pattern: RoutePattern | undefined): RoutePattern | undefined;
export function withDataVariants(pattern: RoutePattern | undefined): RoutePattern | undefined {
  if (pattern === undefined) return undefined;
  const list = Array.isArray(pattern) ? pattern : [pattern];
  const out: Array<string | RegExp> = [];
  for (const p of list) {
    out.push(p);
    if (typeof p === 'string') for (const v of dataRequestVariants(p)) if (!out.includes(v)) out.push(v);
  }
  return out.length === list.length && !Array.isArray(pattern) ? pattern : out;
}

function strings(list: string[] | undefined): string[] | undefined {
  if (!list) return list;
  const out = [...list];
  for (const p of list) for (const v of dataRequestVariants(p)) if (!out.includes(v)) out.push(v);
  return out;
}

type Security = NonNullable<HypDrivConfig['security']>;

function securityWithData<S extends Partial<Security> | ResolvedConfig['security']>(security: S): S {
  const s = security as Record<string, unknown> & Partial<Security>;
  const out: Record<string, unknown> = { ...s };
  if (Array.isArray(s.rateLimit))
    out.rateLimit = s.rateLimit.map((p) => ({ ...p, match: withDataVariants(p.match) }));
  if (Array.isArray(s.maxBody))
    out.maxBody = s.maxBody.map((m) => ({ ...m, match: withDataVariants(m.match) }));
  if (s.csrf && typeof s.csrf === 'object') {
    const csrf = s.csrf as { match?: RoutePattern; exempt?: RoutePattern };
    out.csrf = {
      ...csrf,
      ...(csrf.match !== undefined ? { match: withDataVariants(csrf.match) } : {}),
      ...(csrf.exempt !== undefined ? { exempt: withDataVariants(csrf.exempt) } : {}),
    };
  }
  if (s.bots && typeof s.bots === 'object') {
    const bots = s.bots as { exempt?: RoutePattern };
    if (bots.exempt !== undefined) out.bots = { ...bots, exempt: withDataVariants(bots.exempt) };
  }
  return out as S;
}

/** Copies an object with every own property (the resolved-config brand included). */
function cloneOwn<T extends object>(value: T): T {
  return Object.defineProperties(
    Object.create(Object.getPrototypeOf(value) as object | null) as T,
    Object.getOwnPropertyDescriptors(value),
  );
}

interface RedirectRuleLike {
  from: string;
  to: string;
  [key: string]: unknown;
}

/** Redirect rules plus a `<from>.data` rule for each exact or parameterised source (same destination). */
export function redirectsWithData<R extends RedirectRuleLike>(rules: readonly R[]): R[] {
  const out: R[] = [...rules];
  const sources = new Set(rules.map((r) => r.from));
  for (const rule of rules) {
    if (rule.from.endsWith('*') || rule.from.startsWith('^') || rule.from.includes('\\?')) continue;
    const from = rule.from === '/' ? '/_root.data' : `${rule.from.replace(/\/+$/, '')}.data`;
    if (!sources.has(from)) {
      sources.add(from);
      out.push({ ...rule, from });
    }
  }
  return out;
}

/**
 * Extends the path rules that gate requests — rate limits, CSRF, body-size limits, bot exemptions, maintenance
 * bypass paths and redirect rules — with React Router's data-request spellings. Accepts `hypdriv.config` input and
 * resolved configs.
 */
export function withDataRequests<C extends HypDrivConfig | ResolvedConfig>(config: C): C {
  const out = cloneOwn(config) as C & { security?: unknown; maintenance?: { bypassPaths?: string[] } };
  const source = config as {
    security?: Partial<Security>;
    maintenance?: { bypassPaths?: string[] };
    redirects?: { rules?: RedirectRuleLike[] };
  };
  if (source.redirects && Array.isArray(source.redirects.rules)) {
    (out as { redirects: unknown }).redirects = {
      ...source.redirects,
      rules: redirectsWithData(source.redirects.rules),
    };
  }
  if (source.security) (out as { security: unknown }).security = securityWithData(source.security);
  if (source.maintenance && Array.isArray(source.maintenance.bypassPaths)) {
    (out as { maintenance: unknown }).maintenance = {
      ...source.maintenance,
      bypassPaths: strings(source.maintenance.bypassPaths),
    };
  }
  return out;
}

/**
 * React Router's single-fetch redirect for a data request: a redirect the pipeline answered (redirect rules, the
 * HTTPS upgrade, i18n) becomes `204` + `X-Remix-Redirect`, which the client follows with a document navigation.
 * Other responses are returned unchanged.
 */
export function dataRedirect(request: Request, response: Response): Response {
  if (!isDataRequest(request) || !isRedirect(response)) return response;
  const headers = new Headers(response.headers);
  const location = headers.get('location')!;
  headers.delete('location');
  headers.delete('content-length');
  headers.set('X-Remix-Redirect', location);
  headers.set('X-Remix-Status', String(response.status));
  headers.set('X-Remix-Reload-Document', 'true');
  void response.body?.cancel().catch(() => undefined);
  return new Response(null, { status: 204, headers });
}
