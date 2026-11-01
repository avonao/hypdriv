import {
  appendSetCookie,
  defineStage,
  EXPERIMENT_COOKIE_PENDING_KEY,
  EXPERIMENT_TOKEN_RE,
  type ExperimentMembership,
  experimentGeneration,
  expireCookie,
  FLAGS_COOKIE_PENDING_KEY,
  type FlagDefinition,
  type FlagValue,
  type GeoProperties,
  HEADER,
  type HypContext,
  isHtmlLike,
  isPrefetchRequest,
  isProxyPageMarker,
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
import {
  EXPERIMENT_COOKIE_SECONDS,
  type ExperimentOutcome,
  type ExperimentRequester,
  exposesOn,
} from './experiments';
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

/**
 * Who is asking, for experiments. Only a `visitor` is assigned to a variant, remembered in the cookie and counted:
 * cache warm-ups (`x-hypdriv-warm`), crawlers and preview fetchers (the user agent, or the bot shield's verdict
 * when `security.bots` is on) and the owner's audit tooling (`x-hypdriv-audit`) are not. A client can claim to be
 * one of these, which only takes itself out of the experiment.
 */
export function requesterOf(ctx: HypContext): ExperimentRequester {
  const headers = ctx.request.headers;
  if (headers.has(HEADER.warm)) return 'warm';
  if (detectDevice(headers) === 'bot' || headers.has(HEADER.auditToken)) return 'bot';
  const verdict = ctx.requestHeaders.get(HEADER.bot);
  return verdict === 'likely' || verdict === 'definite' || verdict === 'verified' ? 'bot' : 'visitor';
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
  /** Experiments already reported as unstorable, so the warning appears once per instance, not per request. */
  const warnedUnstorable = new Set<string>();
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

      const requester = requesterOf(ctx);
      const cookies = parseCookies(ctx.request.headers.get('cookie'));
      const memberships = parseExperimentCookie(cookies[f.experimentCookie]);
      if (cookies[f.experimentCookie]) ctx.state.set(INCOMING_COOKIE_KEY, cookies[f.experimentCookie]!);
      const fromCookie = cookies[f.idCookie];
      let stableId = fromCookie && STABLE_ID_RE.test(fromCookie) ? fromCookie : undefined;
      if (!stableId) {
        stableId = randomToken(12);
        // Crawlers and warm-ups are not given a cookie: they are not visitors.
        if (requester === 'visitor' && (remote || needsStableId(definitions)))
          ctx.state.set(FLAGS_COOKIE_PENDING_KEY, true);
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
        requester,
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
      if (requester !== 'visitor') return;
      const next = nextMemberships(definitions, experiments, memberships);
      ctx.state.set(MEMBERSHIPS_KEY, next);
      if (
        mayWriteExperimentCookie(
          ctx,
          definitions,
          experiments,
          next,
          ctx.state.get(INCOMING_COOKIE_KEY),
          options,
        )
      )
        ctx.state.set(EXPERIMENT_COOKIE_PENDING_KEY, true);
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
      finishExperiments(ctx, response, f.experimentCookie, options.onExposure, warnedUnstorable);
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
    const generation = experimentGeneration(spec.salt);
    // A restart (new salt) is a new experiment run: the visitor is counted again.
    next[name] = {
      variant: outcome.variant,
      exposed:
        previous?.variant === outcome.variant &&
        previous.exposed &&
        (previous.generation ?? '') === generation,
      ...(generation ? { generation } : {}),
    };
  }
  return next;
}

/**
 * A page view: a successful, non-speculative GET of an HTML document, or of an RSC payload for a client navigation.
 * Under `proxy.ts` the response is Next's pass-through marker, so the matched route's kind decides (as for the other
 * HTML stages); the marker is always `200`, which means a page that later answers `404` is still counted there.
 */
function isPageView(ctx: HypContext, response: Response): boolean {
  if (ctx.request.method !== 'GET' || response.status < 200 || response.status >= 300) return false;
  if (isPrefetchRequest(ctx.request.headers)) return false;
  if (!isRscRequest(ctx.request.headers)) return isHtmlLike(ctx, response);
  const type = response.headers.get('content-type');
  return type ? type.toLowerCase().includes('text/x-component') : isProxyPageMarker(ctx, response);
}

/** What an exposure row says about where the visit happened when no route matched (never the raw URL). */
const UNMATCHED_ROUTE = '(unmatched)';

/**
 * Whether this response may carry the experiment cookie: the memberships changed, or a member could still be counted
 * on this request (the `*` mark). Cache stages that store per-visitor `Set-Cookie` responses read it through
 * `EXPERIMENT_COOKIE_PENDING_KEY`.
 */
function mayWriteExperimentCookie(
  ctx: HypContext,
  definitions: Record<string, FlagDefinition>,
  outcomes: Record<string, ExperimentOutcome>,
  next: Record<string, ExperimentMembership>,
  incoming: string | undefined,
  options: FlagsStageOptions,
): boolean {
  if (serializeExperimentCookie(next) !== (incoming ?? '')) return true;
  if (!options.onExposure) return false;
  return Object.entries(outcomes).some(([name, outcome]) => {
    const spec = definitions[name]?.experiment;
    return outcome.member && !next[name]?.exposed && !!spec && exposesOn(spec, ctx.url);
  });
}

/** Reports first-time exposures and writes (or clears) the experiment cookie. */
function finishExperiments(
  ctx: HypContext,
  response: Response,
  cookieName: string,
  onExposure: ExposureSink | undefined,
  warned: Set<string>,
): void {
  const next = ctx.state.get(MEMBERSHIPS_KEY);
  if (!next) return;
  const outcomes = ctx.state.get(EXPERIMENTS_KEY) ?? {};
  const definitions = ctx.state.get(DEFINITIONS_KEY) ?? {};
  let value = serializeExperimentCookie(next);
  if (onExposure && isPageView(ctx, response)) {
    const counted: Array<{ name: string; membership: ExperimentMembership }> = [];
    for (const [name, outcome] of Object.entries(outcomes)) {
      const membership = next[name];
      const spec = definitions[name]?.experiment;
      if (!membership || membership.exposed || !outcome.member || !spec || !exposesOn(spec, ctx.url))
        continue;
      membership.exposed = true;
      counted.push({ name, membership });
    }
    if (counted.length) {
      // A visitor is counted once only if the cookie can remember it: a name the cookie cannot hold, or an
      // experiment beyond what it has room for, would be counted again on every page view.
      const stored = parseExperimentCookie(serializeExperimentCookie(next));
      const country = geoForFlags(ctx.cf, ctx.request.headers)?.country;
      const route = ctx.route?.route;
      for (const { name, membership } of counted) {
        const kept = stored[name];
        if (!kept || kept.variant !== membership.variant || !kept.exposed) {
          membership.exposed = false;
          if (!warned.has(name)) {
            warned.add(name);
            ctx.log.warn('experiment cannot be remembered in the cookie, so it is not counted', {
              experiment: name.slice(0, 96),
              reason: EXPERIMENT_TOKEN_RE.test(name)
                ? 'the cookie is full (it remembers 24 experiments per visitor)'
                : 'experiment names must be 1–48 letters, digits, "_" or "-"',
            });
          }
          continue;
        }
        const event = {
          experiment: name,
          variant: membership.variant,
          // The route pattern (`/blog/[slug]`), never the visited URL: paths carry tokens and ids.
          pathname: route?.pathname ?? UNMATCHED_ROUTE,
          ...(route ? { route: route.id } : {}),
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
      value = serializeExperimentCookie(next);
    }
  }
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
