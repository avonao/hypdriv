import {
  appendSetCookie,
  defineStage,
  FLAGS_COOKIE_PENDING_KEY,
  type FlagValue,
  type HypContext,
  parseCookies,
  type ResolvedConfig,
  randomToken,
  type Stage,
  serializeCookie,
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
import type { FlagProvider } from './providers';

/** Evaluated flag values for the current request (written by the `flags` stage). */
export const FLAGS_KEY = stateKey<Record<string, FlagValue>>('flags');
/** Evaluation reasons per flag (`default`, `rule:<i>`, `override`, ...). */
export const FLAG_REASONS_KEY = stateKey<Record<string, string>>('flags.reasons');
/** The stable visitor id used for bucketing (from the cookie, or freshly generated). */
export const FLAG_ID_KEY = stateKey<string>('flags.id');

const COUNT_KEY = stateKey<number>('flags.count');

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
 * The stage does not add `Vary: Cookie`; declare `vary.flags` on edge cache policies for routes whose
 * HTML depends on a flag.
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
        geo: ctx.cf,
        device: detectDevice(ctx.request.headers),
        ...(options.now ? { now: options.now() } : {}),
        ...(overridesAllowed ? { overrides: parseQueryOverrides(ctx.url, definitions) } : {}),
      };
      const result = provider.evaluate ? await provider.evaluate(input) : evaluateFlags(input);
      ctx.state.set(FLAGS_KEY, result.values);
      ctx.state.set(FLAG_REASONS_KEY, result.reasons);
      ctx.requestHeaders.set(f.header, encodeFlagsHeader(result.values));
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
      const count = ctx.state.get(COUNT_KEY);
      // A zero-length record merges into the stage's own `flags` entry: duration stays, desc is added.
      if (count !== undefined) ctx.timings.record('flags', 0, String(count));
      return response;
    },
  });
}
