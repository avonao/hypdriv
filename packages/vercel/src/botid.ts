import { isDevelopment, type Logger, toError } from '@hypdriv/core';
import { ActionError } from '@hypdriv/security';
import { type BotIdHeaders, type CheckBotIdOptions, getVercelSdk } from './sdk';
import { type ConfigInput, defaultLogger, resolveInput, warnOnce } from './util';

/** Options of `verifyBotId`. */
export interface VerifyBotIdOptions {
  /** `basic` (default) or `deepAnalysis` (BotID Deep Analysis, billed separately). */
  checkLevel?: 'basic' | 'deepAnalysis';
  /** Request headers to classify; by default BotID reads the current request (`next/headers` / request context). */
  headers?: Headers | BotIdHeaders;
}

/** A BotID classification. */
export interface BotIdVerdict {
  isBot: boolean;
  isHuman: boolean;
  isVerifiedBot: boolean;
  /** BotID skipped the check (development, or a bypass rule). */
  bypassed: boolean;
  reason?: string;
  verifiedBotName?: string;
  verifiedBotCategory?: string;
}

function toIncomingHeaders(headers: Headers | BotIdHeaders): BotIdHeaders {
  if (!(headers instanceof Headers)) return headers;
  const out: BotIdHeaders = {};
  headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

/**
 * Classifies the current request with Vercel BotID (`checkBotId` from `botid/server`, registered with
 * `registerVercelSdk`). Resolves to `null` when BotID is not registered. The client side still needs
 * `initBotId()` (`botid/client/core`) for the protected paths.
 */
export async function verifyBotId(options: VerifyBotIdOptions = {}): Promise<BotIdVerdict | null> {
  const check = getVercelSdk().checkBotId;
  if (!check) return null;
  const advancedOptions: NonNullable<CheckBotIdOptions['advancedOptions']> = {};
  if (options.checkLevel) advancedOptions.checkLevel = options.checkLevel;
  if (options.headers) advancedOptions.headers = toIncomingHeaders(options.headers);
  const result = await check(Object.keys(advancedOptions).length ? { advancedOptions } : {});
  const reason =
    result.classificationReason ??
    (result.bypassed
      ? 'bypassed'
      : result.isVerifiedBot
        ? `verified-bot${result.verifiedBotName ? `:${result.verifiedBotName}` : ''}`
        : result.isBot
          ? 'bot'
          : 'human');
  return {
    isBot: result.isBot,
    isHuman: result.isHuman,
    isVerifiedBot: result.isVerifiedBot,
    bypassed: result.bypassed,
    reason,
    ...(result.verifiedBotName ? { verifiedBotName: result.verifiedBotName } : {}),
    ...(result.verifiedBotCategory ? { verifiedBotCategory: result.verifiedBotCategory } : {}),
  };
}

/** Options of `botIdGuard`. */
export interface BotIdGuardOptions {
  /** Let verified bots (search engines, monitors) through (default false). */
  allowVerifiedBots?: boolean;
  /** Check level (default `config.vercel.botId.checkLevel`, else `basic`). */
  checkLevel?: 'basic' | 'deepAnalysis';
  /** Supplies the default check level. */
  config?: ConfigInput;
  /**
   * What to do when BotID is not registered or the check fails: `deny` (default in production) or `allow`
   * (default in development, where BotID bypasses anyway).
   */
  onUnavailable?: 'allow' | 'deny';
  log?: Logger;
}

/**
 * A `safeAction` guard that rejects automated callers with `ActionError('FORBIDDEN')`, using Vercel BotID:
 *
 * ```ts
 * export const checkout = safeAction({ input: schema, guards: [botIdGuard()], handler });
 * ```
 */
export function botIdGuard(
  options: BotIdGuardOptions = {},
): (ctx: { headers?: Headers | undefined }) => Promise<void | ActionError> {
  const log = options.log ?? defaultLogger();
  const checkLevel =
    options.checkLevel ??
    (options.config ? resolveInput(options.config) : undefined)?.vercel.botId?.checkLevel;
  const unavailable = (detail: string): void | ActionError => {
    const mode = options.onUnavailable ?? (isDevelopment() ? 'allow' : 'deny');
    warnOnce(
      log,
      `botid:unavailable:${mode}`,
      `BotID unavailable (${detail}); ${mode === 'allow' ? 'allowing' : 'rejecting'} protected actions`,
    );
    return mode === 'allow' ? undefined : new ActionError('FORBIDDEN', 'Bot protection is unavailable');
  };

  return async (ctx) => {
    let verdict: BotIdVerdict | null;
    try {
      verdict = await verifyBotId({
        ...(checkLevel ? { checkLevel } : {}),
        ...(ctx.headers ? { headers: ctx.headers } : {}),
      });
    } catch (error) {
      return unavailable(toError(error).message);
    }
    if (!verdict) return unavailable('botid is not registered: call registerVercelSdk({ checkBotId })');
    if (!verdict.isBot) return undefined;
    if (verdict.isVerifiedBot && options.allowVerifiedBots) return undefined;
    return new ActionError('FORBIDDEN', 'Automated requests are not allowed', {
      details: { reason: verdict.reason ?? 'bot' },
    });
  };
}
