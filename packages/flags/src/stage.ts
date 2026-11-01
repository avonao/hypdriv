import {
  appendSetCookie,
  defineStage,
  type ExperimentMembership,
  expireCookie,
  FLAGS_COOKIE_PENDING_KEY,
  type FlagDefinition,
  type FlagValue,
  type GeoProperties,
  type HypContext,
  isPrefetchRequest,
  isRscRequest,
  parseCookies,
  parseExperimentCookie,
  type ResolvedConfig,
  randomToken,
  type Stage,
  serializeCookie,
  serializeExperimentCookie,
  stateKey,
} from '@hypdriv/core';
import { encodeFlagsHeader } from './encoding';
import {
  evaluateFlags,
  type FlagDevice,
  type FlagEvalInput,
  needsStableId,
  parseQueryOverrides,
} from './evaluate';
import { type ExperimentOutcome, exposesOn } from './experiments';
import type { ExposureSink } from './exposure';
import type { FlagProvider } from './providers';

/** Evaluated flag values for the current request (written by the `flags` stage). */
export const FLAGS_KEY = stateKey<Record<string, FlagValue>>('flags');
/** Evaluation reasons per flag (`default`, `rule:<i>`, `override`, ...). */
export const FLAG_REASONS_KEY = stateKey<Record<string, string>>('flags.reasons');
/** The stable visitor id used for bucketing (from the cookie, or freshly generated). */
export const FLAG_ID_KEY = stateKey<string>('flags.id');

/** The outcome of every experiment for the current request (written by the `flags` stage). */
export const EXPERIMENTS_KEY = stateKey<Record<string, ExperimentOutcome>>('flags.experiments');

const COUNT_KEY = stateKey<number>('flags.count');
/** Memberships as they will be stored in the experiment cookie once the response is built. */
const MEMBERSHIPS_KEY = stateKey<Record<string, ExperimentMembership>>('flags.memberships');
/** The experiment cookie as the request carried it. */
const INCOMING_COOKIE_KEY = stateKey<string>('flags.experimentCookie');
const DEFINITIONS_KEY = stateKey<Record<string, FlagDefinition>>('flags.definitions');
const EXPERIMENT_COOKIE_SECONDS = 180 * 24 * 60 * 60;

/** Stable ids are 8–64 URL-safe characters; anything else is treated as missing. */
const STABLE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * Cheap device classification from client hints and the user agent. `bot` wins over `mobile` so
 * crawlers never receive mobile-only variants by accident.
 */
export function detectDevice(headers: Headers): FlagDevice {
  const ua = headers.get('user-agent') ?? '';
  if (/bot|crawl|spider|slurp|headless|lighthouse|pingdom|facebookexternalhit|preview/i.test(ua))
    return 'bot';
  const hint = headers.get('sec-ch-ua-mobile');
  if (hint === '?1') return 'mobile';
  if (hint === '?0') return 'desktop';
  if (/Mobi|Android|iPhone|iPod|Windows Phone|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

export interface FlagsStageOptions {
  /** Clock for `from`/`until` windows (tests). */
  now?: () => Date;
  /** Receives each experiment exposure (once per visitor and experiment). Default: none. */
  onExposure?: ExposureSink;
}

/**
 * The `flags` stage (Drivetrain position 6).
 *
 * `pre`: reads the stable id cookie (`config.flags.idCookie`, generated when missing and needed),
 * loads definitions from the provider, evaluates them with geo from `ctx.cf`, the device class and
 * QA overrides (`?hyp_flag_<name>=` when `queryOverrides` allows), stores `FLAGS_KEY`/`FLAG_REASONS_KEY`
 * and forwards every value to Next.js in `config.flags.header` (an incoming header with that name is
 * always replaced, so clients cannot inject flags). `post`: sets the id cookie once (1 year, Lax,
 * HttpOnly, Secure on https) and annotates the `flags` Server-Timing entry with the flag count.
 *
 * Experiments (definitions with an `experiment` block) are flags whose value is the visitor's variant. Their
 * assignments stay sticky in `config.flags.experimentCookie`, and the first page view of a member on an `expose`
 * path is reported once to `options.onExposure` (and marked in the cookie).
 *
 * The stage does not add `Vary: Cookie`; declare `vary.flags` on edge cache policies for routes whose
 * HTML depends on a flag or an experiment.
 */
export function flagsStage(
  config: ResolvedConfig,
  provider: FlagProvider,
  options: FlagsStageOptions = {},
): Stage {
  const f = config.flags;
  const remote = typeof provider.evaluate === 'function';
  return defineStage({
    name: 'flags',
    async pre(ctx: HypContext) {
      const definitions = await provider.load();
      const count = Object.keys(definitions).length;
      ctx.state.set(COUNT_KEY, count);
      if (count === 0) {
        ctx.state.set(FLAGS_KEY, {});
        ctx.state.set(FLAG_REASONS_KEY, {});
        ctx.requestHeaders.delete(f.header);
        return;
      }

      const cookies = parseCookies(ctx.request.headers.get('cookie'));
      const memberships = parseExperimentCookie(cookies[f.experimentCookie]);
      if (cookies[f.experimentCookie]) ctx.state.set(INCOMING_COOKIE_KEY, cookies[f.experimentCookie]!);
      const fromCookie = cookies[f.idCookie];
      let stableId = fromCookie && STABLE_ID_RE.test(fromCookie) ? fromCookie : undefined;
      if (!stableId) {
        stableId = randomToken(12);
        if (remote || needsStableId(definitions)) ctx.state.set(FLAGS_COOKIE_PENDING_KEY, true);
      }
      ctx.state.set(FLAG_ID_KEY, stableId);

      const overridesAllowed =
        f.queryOverrides === true || (f.queryOverrides === 'development' && ctx.development);
      const input: FlagEvalInput = {
        definitions,
        stableId,
        url: ctx.url,
        headers: ctx.request.headers,
        cookies,
        memberships,
        geo: geoForFlags(ctx.cf, ctx.request.headers),
        device: detectDevice(ctx.request.headers),
        ...(options.now ? { now: options.now() } : {}),
        ...(overridesAllowed ? { overrides: parseQueryOverrides(ctx.url, definitions) } : {}),
      };
      const result = provider.evaluate ? await provider.evaluate(input) : evaluateFlags(input);
      ctx.state.set(FLAGS_KEY, result.values);
      ctx.state.set(FLAG_REASONS_KEY, result.reasons);
      ctx.requestHeaders.set(f.header, encodeFlagsHeader(result.values));
      const experiments = result.experiments ?? {};
      ctx.state.set(EXPERIMENTS_KEY, experiments);
      ctx.state.set(DEFINITIONS_KEY, definitions);
      ctx.state.set(MEMBERSHIPS_KEY, nextMemberships(definitions, experiments, memberships));
    },
    post(ctx, response) {
      if (ctx.state.get(FLAGS_COOKIE_PENDING_KEY)) {
        const id = ctx.state.get(FLAG_ID_KEY);
        if (id) {
          appendSetCookie(
            ctx.responseHeaders,
            serializeCookie(f.idCookie, id, {
              maxAge: ONE_YEAR_SECONDS,
              path: '/',
              sameSite: 'lax',
              httpOnly: true,
              secure: ctx.url.protocol === 'https:',
            }),
          );
        }
      }
      finishExperiments(ctx, response, f.experimentCookie, options.onExposure);
      const count = ctx.state.get(COUNT_KEY);
      // A zero-length record merges into the stage's own `flags` entry: duration stays, desc is added.
      if (count !== undefined) ctx.timings.record('flags', 0, String(count));
      return response;
    },
  });
}

/**
 * Geo for rule evaluation: Cloudflare's `request.cf`, else the platform's geo headers (Vercel `x-vercel-ip-*`,
 * Cloudflare `cf-ipcountry` behind a proxy) — country and continent rules must match on every platform.
 */
export function geoForFlags(cf: GeoProperties | undefined, headers: Headers): GeoProperties | undefined {
  if (cf?.country) return cf;
  const country = headers.get('x-vercel-ip-country') ?? headers.get('cf-ipcountry');
  if (!country || country === 'XX' || country === 'T1') return cf;
  const continent = headers.get('x-vercel-ip-continent') ?? headers.get('cf-ipcontinent');
  const region = headers.get('x-vercel-ip-country-region');
  return {
    ...(cf ?? {}),
    country,
    ...(continent ? { continent } : {}),
    ...(region ? { region, regionCode: region } : {}),
  };
}

/**
 * The memberships to store once this response is built: members of a running (or paused-but-sticky) experiment,
 * with their exposure mark kept while the variant is unchanged. A visitor who forced a variant with a QA override
 * keeps the membership they really have.
 */
function nextMemberships(
  definitions: Record<string, FlagDefinition>,
  outcomes: Record<string, ExperimentOutcome>,
  current: Record<string, ExperimentMembership>,
): Record<string, ExperimentMembership> {
  const next: Record<string, ExperimentMembership> = {};
  for (const [name, def] of Object.entries(definitions)) {
    const spec = def.experiment;
    if (!spec) continue;
    const outcome = outcomes[name];
    if (!outcome) {
      const kept = current[name];
      if (kept && Object.hasOwn(spec.variants, kept.variant)) next[name] = { ...kept };
      continue;
    }
    if (!outcome.member) continue;
    const previous = current[name];
    next[name] = {
      variant: outcome.variant,
      exposed: previous?.variant === outcome.variant && previous.exposed,
    };
  }
  return next;
}

/** A page view: a successful HTML document, or a non-prefetch client navigation (RSC payload). */
function isPageView(ctx: HypContext, response: Response): boolean {
  if (ctx.request.method !== 'GET' || response.status < 200 || response.status >= 300) return false;
  if (isPrefetchRequest(ctx.request.headers)) return false;
  const type = response.headers.get('content-type') ?? '';
  return isRscRequest(ctx.request.headers) ? type.includes('text/x-component') : type.includes('text/html');
}

/** Reports first-time exposures and writes (or clears) the experiment cookie. */
function finishExperiments(
  ctx: HypContext,
  response: Response,
  cookieName: string,
  onExposure: ExposureSink | undefined,
): void {
  const next = ctx.state.get(MEMBERSHIPS_KEY);
  if (!next) return;
  const outcomes = ctx.state.get(EXPERIMENTS_KEY) ?? {};
  const definitions = ctx.state.get(DEFINITIONS_KEY) ?? {};
  if (onExposure && isPageView(ctx, response)) {
    for (const [name, outcome] of Object.entries(outcomes)) {
      const membership = next[name];
      const spec = definitions[name]?.experiment;
      if (!membership || membership.exposed || !outcome.member || !spec || !exposesOn(spec, ctx.url))
        continue;
      membership.exposed = true;
      const country = geoForFlags(ctx.cf, ctx.request.headers)?.country;
      const event = {
        experiment: name,
        variant: membership.variant,
        pathname: ctx.url.pathname,
        ...(ctx.route ? { route: ctx.route.route.id } : {}),
        ...(country ? { country } : {}),
        ...(ctx.manifest.buildId ? { buildId: ctx.manifest.buildId } : {}),
        ts: Date.now(),
      };
      // Reporting must never delay or fail the response.
      void Promise.resolve()
        .then(() => onExposure(event))
        .catch((error: unknown) =>
          ctx.log.warn('experiment exposure failed', {
            experiment: name,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
  }
  const value = serializeExperimentCookie(next);
  const incoming = ctx.state.get(INCOMING_COOKIE_KEY);
  if (value === (incoming ?? '')) return;
  appendSetCookie(
    ctx.responseHeaders,
    value
      ? serializeCookie(cookieName, value, {
          maxAge: EXPERIMENT_COOKIE_SECONDS,
          path: '/',
          sameSite: 'lax',
          httpOnly: true,
          secure: ctx.url.protocol === 'https:',
        })
      : expireCookie(cookieName, { path: '/' }),
  );
}
