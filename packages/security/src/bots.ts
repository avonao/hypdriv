import {
  base64UrlEncode,
  createNonce,
  defineStage,
  getCookie,
  HEADER,
  type HypContext,
  hmacSign,
  html,
  json,
  matchesAny,
  type ResolvedBots,
  type ResolvedConfig,
  readEnv,
  type Stage,
  serializeCookie,
  shortHash,
  timingSafeEqual,
} from '@hypdriv/core';
import { verifiedAudit } from './audit-token';
import { BOT_KEY, type BotClassification } from './keys';
import {
  readTurnstileToken,
  TURNSTILE_TOKEN_FIELD,
  turnstileChallengePage,
  verifyTurnstile,
} from './turnstile';

/** User agents of search and social crawlers treated as `verified` (spoofable without Bot Management). */
export const VERIFIED_BOT_USER_AGENTS: ReadonlyArray<RegExp> = [
  /Googlebot|Google-InspectionTool|Storebot-Google|GoogleOther|AdsBot-Google|Mediapartners-Google/i,
  /bingbot|adidxbot|BingPreview/i,
  /DuckDuckBot|DuckDuckGo-Favicons-Bot/i,
  /Applebot/i,
  /YandexBot|YandexImages|YandexMobileBot/i,
  /Baiduspider/i,
  /facebookexternalhit|facebookcatalog|meta-externalagent/i,
  /Twitterbot/i,
  /LinkedInBot/i,
  /Slackbot|Slack-ImgProxy/i,
  /Discordbot/i,
  /WhatsApp/i,
  /TelegramBot/i,
  /Pinterestbot/i,
];

/** SEO/AI crawlers and generic crawler tokens: `likely` automated, never `definite`. */
export const CRAWLER_USER_AGENTS: ReadonlyArray<RegExp> = [
  /AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|BLEXBot|DataForSeoBot|Bytespider|SeznamBot|Sogou|Exabot|MegaIndex|serpstatbot/i,
  /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|CCBot|Amazonbot|PerplexityBot|YouBot|Diffbot|cohere-ai|Google-Extended|Applebot-Extended|ImagesiftBot|omgili/i,
  /\bbot\b|crawler|crawling|spider|slurp|archiver|fetcher|monitor(?:ing)?\b|uptime|preview\b/i,
];

/** Default automation / scripting user-agent tokens. Extend with `blockUserAgents` or the stage option. */
export const DEFAULT_AUTOMATION_USER_AGENTS: ReadonlyArray<string | RegExp> = [
  'HeadlessChrome',
  'PhantomJS',
  /Puppeteer|Playwright|Selenium|WebDriver/i,
  'python-requests',
  /python-urllib|python-httpx|aiohttp/i,
  /^curl\//i,
  /^Wget\//i,
  'Go-http-client',
  'scrapy',
  'node-fetch',
  /^axios\//i,
  /^okhttp\//i,
  /libwww-perl|lwp-trivial|Apache-HttpClient|^Java\/|^Jakarta/i,
  /sqlmap|nikto|masscan|zgrab|nmap|nuclei|dirbuster|gobuster|wpscan/i,
];

function matchesUa(ua: string, patterns: ReadonlyArray<string | RegExp>): string | null {
  for (const p of patterns) {
    if (typeof p === 'string') {
      if (ua.toLowerCase().includes(p.toLowerCase())) return p;
    } else if (p.test(ua)) {
      const m = p.exec(ua);
      return m?.[0] ?? p.source;
    }
  }
  return null;
}

/** `true` for navigations (documents), using `Sec-Fetch-*` when present and `Accept` otherwise. */
export function isNavigationRequest(headers: Headers): boolean {
  const mode = headers.get('sec-fetch-mode');
  const dest = headers.get('sec-fetch-dest');
  if (mode || dest) return mode === 'navigate' || dest === 'document' || dest === 'iframe';
  return (headers.get('accept') ?? '').includes('text/html');
}

const SEC_FETCH_MODES = new Set(['cors', 'navigate', 'no-cors', 'same-origin', 'websocket']);
const SEC_FETCH_SITES = new Set(['cross-site', 'same-origin', 'same-site', 'none']);

function secFetchInconsistency(headers: Headers, ua: string, method: string): string | null {
  const mode = headers.get('sec-fetch-mode');
  const dest = headers.get('sec-fetch-dest');
  const site = headers.get('sec-fetch-site');
  const user = headers.get('sec-fetch-user');
  if (mode && !SEC_FETCH_MODES.has(mode)) return 'sec-fetch:invalid-mode';
  if (site && !SEC_FETCH_SITES.has(site)) return 'sec-fetch:invalid-site';
  if (dest === 'document' && mode && mode !== 'navigate') return 'sec-fetch:dest-mode-mismatch';
  if (user === '?1' && mode && mode !== 'navigate') return 'sec-fetch:user-without-navigate';
  if (!mode && !dest && !site && method === 'GET' && (headers.get('accept') ?? '').includes('text/html')) {
    // Modern Chrome (80+) and Firefox (90+) always send Sec-Fetch-* on navigations.
    const chrome = /Chrome\/(\d+)/.exec(ua);
    const firefox = /Firefox\/(\d+)/.exec(ua);
    if ((chrome && Number(chrome[1]) >= 80) || (firefox && Number(firefox[1]) >= 90))
      return 'sec-fetch:missing';
  }
  return null;
}

/** Options of `classifyRequest` and `botsStage`. */
export interface BotClassifyOptions {
  /** Replaces the built-in automation token list (`blockUserAgents` from config still applies). */
  automationUserAgents?: ReadonlyArray<string | RegExp>;
}

/**
 * Classifies a request as `human`, `verified`, `likely` or `definite` using Cloudflare Bot Management
 * (when present), user-agent lists, honeypot paths and header heuristics.
 *
 * Automation tokens (`curl`, `okhttp`, `axios`, …) are `definite` on document requests and only `likely`
 * on API-style requests, so mobile apps and CLI clients keep working under the default `log` policy.
 */
export function classifyRequest(
  ctx: HypContext,
  config: ResolvedBots,
  options: BotClassifyOptions = {},
): BotClassification {
  const headers = ctx.request.headers;
  const ua = (headers.get('user-agent') ?? '').trim();
  const bm = ctx.cf?.botManagement;
  const score = typeof bm?.score === 'number' ? bm.score : undefined;
  const withScore = (c: BotClassification): BotClassification => (score === undefined ? c : { ...c, score });

  if (config.allowUserAgents.length && matchesUa(ua, config.allowUserAgents))
    return withScore({ verdict: 'human', reason: 'ua:allow-list' });
  if (bm?.verifiedBot === true || ctx.cf?.verifiedBotCategory)
    return withScore({
      verdict: 'verified',
      reason: `cf:verified-bot${ctx.cf?.verifiedBotCategory ? `:${ctx.cf.verifiedBotCategory}` : ''}`,
    });

  const blocked = config.blockUserAgents.length ? matchesUa(ua, config.blockUserAgents) : null;
  if (blocked) return withScore({ verdict: 'definite', reason: `ua:block-list:${blocked}` });
  if (config.honeypots.length && matchesAny(config.honeypots, ctx.url))
    return withScore({ verdict: 'definite', reason: 'honeypot' });
  if (score !== undefined && score < 2) return withScore({ verdict: 'definite', reason: 'cf:score' });

  const navigation = isNavigationRequest(headers);
  if (!ua && navigation) return { verdict: 'definite', reason: 'ua:empty' };

  const automation = matchesUa(ua, options.automationUserAgents ?? DEFAULT_AUTOMATION_USER_AGENTS);
  if (automation)
    return withScore({ verdict: navigation ? 'definite' : 'likely', reason: `ua:${automation}` });

  const verified = matchesUa(ua, VERIFIED_BOT_USER_AGENTS);
  if (verified) {
    if (bm && bm.verifiedBot === false)
      return withScore({ verdict: 'likely', reason: `ua:spoofed:${verified}` });
    return withScore({ verdict: 'verified', reason: `ua:${verified}` });
  }
  const crawler = matchesUa(ua, CRAWLER_USER_AGENTS);
  if (crawler) return withScore({ verdict: 'likely', reason: `ua:crawler:${crawler}` });
  if (score !== undefined && score < config.scoreThreshold)
    return withScore({ verdict: 'likely', reason: 'cf:score' });

  if (
    ctx.request.method === 'GET' &&
    ua.startsWith('Mozilla/') &&
    !headers.has('accept') &&
    !headers.has('accept-language')
  )
    return withScore({ verdict: 'likely', reason: 'headers:missing-accept' });
  if (config.secFetchChecks) {
    const issue = secFetchInconsistency(headers, ua, ctx.request.method);
    if (issue) return withScore({ verdict: 'likely', reason: issue });
  }
  return withScore({ verdict: 'human', reason: 'ok' });
}

/** Options of `botsStage`. */
export interface BotsStageOptions extends BotClassifyOptions {
  /** Custom Turnstile verifier (defaults to `verifyTurnstile` with the configured secret). */
  turnstileVerify?: (token: string, ip: string) => Promise<boolean>;
  /** Cookie that remembers a passed challenge (default `hyp_clearance`). */
  clearanceCookie?: string;
  /** Clearance lifetime in seconds (default 1800). */
  clearanceTtlSeconds?: number;
  /** Header the challenge page sets when posting the token back (default `x-hypdriv-challenge`). */
  resubmitHeader?: string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function clearanceToken(secret: string, ua: string, exp: number): Promise<string> {
  const payload = `${exp}.${shortHash(ua)}`;
  return `${payload}.${base64UrlEncode(await hmacSign(secret, `clearance:${payload}`))}`;
}

async function hasClearance(
  secret: string,
  value: string | undefined,
  ua: string,
  now: number,
): Promise<boolean> {
  if (!value) return false;
  const [exp, uaHash, sig] = value.split('.');
  if (!exp || !uaHash || !sig) return false;
  if (Number(exp) * 1000 < now || uaHash !== shortHash(ua)) return false;
  const expected = base64UrlEncode(await hmacSign(secret, `clearance:${exp}.${uaHash}`));
  return timingSafeEqual(expected, sig);
}

/**
 * The `bots` stage: classifies the request and applies the configured policy per verdict
 * (`allow` / `log` / `block` / `tarpit` / `challenge`). Challenges use Turnstile; a passed challenge
 * sets a signed clearance cookie so the visitor is not challenged on every request.
 */
export function botsStage(config: ResolvedConfig, options: BotsStageOptions = {}): Stage {
  const bots = config.security.bots;
  const cookieName = options.clearanceCookie ?? 'hyp_clearance';
  const ttl = options.clearanceTtlSeconds ?? 1800;
  const resubmitHeader = options.resubmitHeader ?? 'x-hypdriv-challenge';
  const sleep = options.sleep ?? defaultSleep;

  const secretFor = (ctx: HypContext): string | undefined =>
    readEnv(ctx.env, config.security.sessions.secretEnv) ??
    (bots?.turnstile ? readEnv(ctx.env, bots.turnstile.secretEnv) : undefined);

  const verify = async (ctx: HypContext, token: string): Promise<boolean> => {
    if (options.turnstileVerify) return options.turnstileVerify(token, ctx.ip);
    const secret = bots?.turnstile ? readEnv(ctx.env, bots.turnstile.secretEnv) : undefined;
    if (!secret) return false;
    const result = await verifyTurnstile(secret, token, ctx.ip);
    if (!result.success) return false;
    if (bots?.turnstile?.action && result.action && result.action !== bots.turnstile.action) return false;
    return true;
  };

  const clearanceCookie = async (ctx: HypContext): Promise<string | null> => {
    const secret = secretFor(ctx);
    if (!secret) return null;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const value = await clearanceToken(secret, ctx.request.headers.get('user-agent') ?? '', exp);
    return serializeCookie(cookieName, value, {
      httpOnly: true,
      secure: ctx.url.protocol === 'https:',
      sameSite: 'lax',
      path: '/',
      maxAge: ttl,
    });
  };

  const challengeResponse = (ctx: HypContext): Response => {
    const turnstile = bots?.turnstile;
    const siteKey =
      turnstile?.siteKey ?? (turnstile?.siteKeyEnv ? readEnv(ctx.env, turnstile.siteKeyEnv) : undefined);
    if (!turnstile || !siteKey)
      return json(
        { error: 'forbidden', reason: 'challenge-unavailable' },
        { status: 403, headers: { [HEADER.bot]: 'challenge' } },
      );
    const nonce = createNonce();
    return html(turnstileChallengePage({ siteKey, nonce, action: turnstile.action, resubmitHeader }), {
      status: 403,
      headers: {
        'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'`,
        [HEADER.bot]: 'challenge',
        vary: 'cookie',
      },
    });
  };

  return defineStage({
    name: 'bots',
    async pre(ctx) {
      if (!bots) return;
      if (matchesAny(bots.exempt, ctx.url)) return;
      // The owner's own tooling (`hypdriv audit`, headless-Chrome CSS audit, bench, warm) signs its requests.
      if (await verifiedAudit(ctx, config)) {
        const audit: BotClassification = { verdict: 'human', reason: 'audit-token' };
        ctx.state.set(BOT_KEY, audit);
        ctx.timings.mark('bot', 'audit');
        ctx.requestHeaders.set(HEADER.bot, audit.verdict);
        return;
      }
      const headers = ctx.request.headers;
      const ua = headers.get('user-agent') ?? '';
      const secret = secretFor(ctx);

      // Token posted back by the challenge page: verify and hand out a clearance cookie.
      if (ctx.request.method === 'POST' && headers.get(resubmitHeader) === '1') {
        const token = await readTurnstileToken(ctx.request, TURNSTILE_TOKEN_FIELD);
        if (token && (await verify(ctx, token))) {
          const cookie = await clearanceCookie(ctx);
          ctx.state.set(BOT_KEY, { verdict: 'human', reason: 'challenge-passed' });
          ctx.timings.mark('bot', 'challenge-passed');
          return new Response(null, { status: 204, headers: cookie ? { 'set-cookie': cookie } : {} });
        }
        return json({ error: 'forbidden', reason: 'challenge-failed' }, { status: 403 });
      }

      if (secret && (await hasClearance(secret, getCookie(headers, cookieName), ua, Date.now()))) {
        const result: BotClassification = { verdict: 'human', reason: 'clearance' };
        ctx.state.set(BOT_KEY, result);
        ctx.requestHeaders.set(HEADER.bot, result.verdict);
        return;
      }

      const result = classifyRequest(ctx, bots, options);
      ctx.state.set(BOT_KEY, result);
      ctx.timings.mark('bot', result.verdict);
      ctx.requestHeaders.set(HEADER.bot, result.verdict);
      const policy =
        result.verdict === 'verified'
          ? bots.verified
          : result.verdict === 'likely'
            ? bots.likelyAutomated
            : result.verdict === 'definite'
              ? bots.definitelyAutomated
              : 'allow';
      const fields = {
        verdict: result.verdict,
        reason: result.reason,
        score: result.score,
        ua,
        path: ctx.url.pathname,
      };

      switch (policy) {
        case 'allow':
          return;
        case 'log':
          ctx.log.info('bot traffic', fields);
          return;
        case 'block':
          ctx.log.warn('bot blocked', fields);
          return json(
            { error: 'forbidden', reason: 'automated' },
            { status: 403, headers: { [HEADER.bot]: result.verdict } },
          );
        case 'tarpit':
          ctx.log.warn('bot tarpitted', fields);
          await sleep(bots.tarpitMs, ctx.signal);
          return json(
            { error: 'too_many_requests', reason: 'automated' },
            { status: 429, headers: { [HEADER.bot]: result.verdict, 'retry-after': '60' } },
          );
        case 'challenge': {
          const token = bots.turnstile ? await readTurnstileToken(ctx.request, TURNSTILE_TOKEN_FIELD) : null;
          if (token && (await verify(ctx, token))) {
            const cookie = await clearanceCookie(ctx);
            if (cookie) ctx.responseHeaders.append('set-cookie', cookie);
            ctx.state.set(BOT_KEY, { ...result, verdict: 'human', reason: 'challenge-passed' });
            ctx.requestHeaders.set(HEADER.bot, 'human');
            return;
          }
          ctx.log.info('bot challenged', fields);
          return challengeResponse(ctx);
        }
        default:
          return;
      }
    },
  });
}
