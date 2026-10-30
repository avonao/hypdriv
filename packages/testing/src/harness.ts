import {
  createContext,
  type GeoProperties,
  getSetCookies,
  type HypContext,
  type HypDrivConfig,
  type HypManifest,
  type Logger,
  loadConfig,
  type PipelineResult,
  type ResolvedConfig,
  type RouteMatch,
  type Runner,
  type RunPipelineOptions,
  runPipeline,
  type Stage,
  type TimingEntry,
} from '@hypdriv/core';

export interface TestContextOptions {
  /** Request URL (default `https://example.com/`). */
  url?: string | URL;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  /** Cloudflare `request.cf` properties (geo, bot management ...), also attached to the Request. */
  cf?: GeoProperties;
  env?: Record<string, unknown>;
  /** Raw or resolved config; defaults from `loadConfig({})`. */
  config?: HypDrivConfig | ResolvedConfig;
  manifest?: HypManifest | null;
  runner?: Runner;
  development?: boolean;
  route?: RouteMatch | null;
  ip?: string;
  id?: string;
  log?: Logger;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** `true` for objects that already went through `resolveConfig()`. */
export function isResolvedConfig(
  config: HypDrivConfig | ResolvedConfig | undefined,
): config is ResolvedConfig {
  if (!config || typeof config !== 'object') return false;
  const c = config as Partial<ResolvedConfig>;
  return (
    !!c.stages &&
    Array.isArray((c.stages as { disable?: unknown }).disable) &&
    typeof (c.cloudflare as { internalPathPrefix?: unknown } | undefined)?.internalPathPrefix === 'string' &&
    typeof (c.site as { name?: unknown } | undefined)?.name === 'string'
  );
}

/** Builds a `Request` with Cloudflare's `cf` property attached (as workerd does for incoming requests). */
export function requestWithCf(
  url: string | URL,
  init: RequestInit = {},
  cf: GeoProperties = {},
): Request & { cf: GeoProperties } {
  const request = new Request(typeof url === 'string' ? url : url.href, init) as Request & {
    cf: GeoProperties;
  };
  Object.defineProperty(request, 'cf', { value: cf, enumerable: true, configurable: true, writable: true });
  return request;
}

/** Creates a `HypContext` the way the Worker shell / proxy would, with sensible defaults for tests. */
export function createTestContext(options: TestContextOptions = {}): HypContext {
  const config = isResolvedConfig(options.config) ? options.config : loadConfig(options.config);
  const url = options.url ?? 'https://example.com/';
  const init: RequestInit = { method: options.method ?? 'GET', headers: options.headers };
  if (options.body !== undefined && options.body !== null && init.method !== 'GET' && init.method !== 'HEAD')
    init.body = options.body;
  const request = options.cf
    ? requestWithCf(url, init, options.cf)
    : new Request(typeof url === 'string' ? url : url.href, init);
  return createContext({
    request,
    config,
    manifest: options.manifest,
    env: options.env ?? {},
    cf: options.cf,
    runner: options.runner ?? 'test',
    development: options.development ?? false,
    route: options.route ?? null,
    ip: options.ip,
    id: options.id,
    log: options.log,
    waitUntil: options.waitUntil,
  });
}

export interface RunStageResult {
  response: Response;
  /** `true` when the stage's `pre` returned a Response (the `next` handler did not run). */
  shortCircuited: boolean;
  /** Timings recorded on the context (stage `pre`, `next`, stage `post`). */
  timings: readonly TimingEntry[];
  /** Whether `next` was invoked. */
  nextCalled: boolean;
  /** The request `next` received (with forwarded headers applied), when it ran. */
  forwarded: Request | null;
}

export type NextHandler = (request: Request) => Promise<Response> | Response;

const defaultNext: NextHandler = () =>
  new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } });

/**
 * Runs one stage's `pre`, then `next` (default: a 200 `ok` response) unless short-circuited, then `post`,
 * with the same semantics as the Drivetrain (`runPipeline`): internal/RSC filters, timings and
 * `ctx.responseHeaders` merging all apply.
 */
export async function runStage(
  stage: Stage,
  ctx: HypContext,
  next: NextHandler = defaultNext,
): Promise<RunStageResult> {
  let forwarded: Request | null = null;
  let nextCalled = false;
  const result = await runPipeline({
    stages: [stage],
    ctx,
    next: async (request) => {
      nextCalled = true;
      forwarded = request;
      return next(request);
    },
  });
  return {
    response: result.response,
    shortCircuited: result.shortCircuitedBy === stage.name,
    timings: ctx.timings.list(),
    nextCalled,
    forwarded,
  };
}

/** Runs several stages through core's `runPipeline` (same options minus `stages`/`ctx`/`next`). */
export function runStages(
  stages: readonly Stage[],
  ctx: HypContext,
  next: NextHandler = defaultNext,
  options: Omit<RunPipelineOptions, 'stages' | 'ctx' | 'next'> = {},
): Promise<PipelineResult> {
  return runPipeline({ ...options, stages, ctx, next: async (request) => next(request) });
}

export type HeaderExpectation = string | RegExp | null;

/**
 * Asserts response headers: a string must match exactly (case-insensitive header names), a RegExp must
 * test true, `null` means the header must be absent. Throws one readable error listing every mismatch.
 */
export function expectHeaders(response: Response, expected: Record<string, HeaderExpectation>): void {
  const problems: string[] = [];
  for (const [name, expectation] of Object.entries(expected)) {
    const actual =
      name.toLowerCase() === 'set-cookie'
        ? getSetCookies(response.headers).join(', ') || null
        : response.headers.get(name);
    if (expectation === null) {
      if (actual !== null) problems.push(`  ${name}: expected to be absent, got ${JSON.stringify(actual)}`);
    } else if (expectation instanceof RegExp) {
      if (actual === null || !expectation.test(actual))
        problems.push(`  ${name}: expected to match ${expectation}, got ${JSON.stringify(actual)}`);
    } else if (actual !== expectation) {
      problems.push(`  ${name}: expected ${JSON.stringify(expectation)}, got ${JSON.stringify(actual)}`);
    }
  }
  if (problems.length) {
    const all: string[] = [];
    response.headers.forEach((v, k) => all.push(`  ${k}: ${v}`));
    throw new Error(
      `Header expectations failed (status ${response.status}):\n${problems.join('\n')}\n\nActual headers:\n${all.join('\n') || '  (none)'}`,
    );
  }
}

/** All `Set-Cookie` values of a response. */
export function collectSetCookies(response: Response): string[] {
  return getSetCookies(response.headers);
}

/** Parses a `Set-Cookie` value into its name, value and attributes (lower-cased keys). */
export function parseSetCookie(value: string): {
  name: string;
  value: string;
  attributes: Record<string, string | true>;
} {
  const [pair = '', ...attrs] = value.split(';');
  const idx = pair.indexOf('=');
  const name = idx === -1 ? pair.trim() : pair.slice(0, idx).trim();
  const raw = idx === -1 ? '' : pair.slice(idx + 1).trim();
  const attributes: Record<string, string | true> = {};
  for (const attr of attrs) {
    const [k, ...rest] = attr.split('=');
    const key = (k ?? '').trim().toLowerCase();
    if (!key) continue;
    attributes[key] = rest.length ? rest.join('=').trim() : true;
  }
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  return { name, value: decoded, attributes };
}

export const TEST_ENV_GLOBAL = '__hypdriv_test_env__';

/**
 * Exposes `env` on `globalThis.__hypdriv_test_env__` for the duration of `fn` (what server helpers read
 * when no Cloudflare context exists), restoring the previous value afterwards, sync or async.
 */
export function withEnv<T>(env: Record<string, unknown>, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const had = Object.hasOwn(g, TEST_ENV_GLOBAL);
  const previous = g[TEST_ENV_GLOBAL];
  g[TEST_ENV_GLOBAL] = env;
  const restore = () => {
    if (had) g[TEST_ENV_GLOBAL] = previous;
    else delete g[TEST_ENV_GLOBAL];
  };
  let result: T;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}

/** Reads the env installed by `withEnv`, if any. */
export function currentTestEnv(): Record<string, unknown> | undefined {
  return (globalThis as Record<string, unknown>)[TEST_ENV_GLOBAL] as Record<string, unknown> | undefined;
}

/** Reads a JSON body once (clones so the response stays usable). */
export async function responseJson<T = unknown>(response: Response): Promise<T> {
  return (await response.clone().json()) as T;
}

/** Reads a text body once (clones so the response stays usable). */
export async function responseText(response: Response): Promise<string> {
  return response.clone().text();
}
