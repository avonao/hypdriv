import { loadConfig } from '@hypdriv/core';
import { ActionError, safeAction } from '@hypdriv/security';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogger } from './__fixtures__/fakes';
import { botIdGuard, verifyBotId } from './botid';
import { __resetVercelSdk, type CheckBotIdOptions, type CheckBotIdResult, registerVercelSdk } from './sdk';
import { __resetWarnings } from './util';

const HUMAN: CheckBotIdResult = { isHuman: true, isBot: false, isVerifiedBot: false, bypassed: false };
const BOT: CheckBotIdResult = { isHuman: false, isBot: true, isVerifiedBot: false, bypassed: false };
const GOOGLEBOT: CheckBotIdResult = {
  isHuman: false,
  isBot: true,
  isVerifiedBot: true,
  bypassed: false,
  verifiedBotName: 'googlebot',
  verifiedBotCategory: 'search_engine_crawler',
};

const seen: Array<CheckBotIdOptions | undefined> = [];
function register(result: CheckBotIdResult | Error) {
  registerVercelSdk({
    checkBotId: async (options) => {
      seen.push(options);
      if (result instanceof Error) throw result;
      return result;
    },
  });
}

beforeEach(() => {
  seen.length = 0;
  __resetVercelSdk();
  __resetWarnings();
});
afterEach(() => __resetVercelSdk());

describe('verifyBotId', () => {
  it('is null when BotID is not registered', async () => {
    expect(await verifyBotId()).toBeNull();
  });

  it('maps the BotID result and passes options through', async () => {
    register(GOOGLEBOT);
    const verdict = await verifyBotId({
      checkLevel: 'deepAnalysis',
      headers: new Headers({ 'x-is-human': 'abc' }),
    });
    expect(verdict).toEqual({
      isBot: true,
      isHuman: false,
      isVerifiedBot: true,
      bypassed: false,
      reason: 'verified-bot:googlebot',
      verifiedBotName: 'googlebot',
      verifiedBotCategory: 'search_engine_crawler',
    });
    expect(seen[0]).toEqual({
      advancedOptions: { checkLevel: 'deepAnalysis', headers: { 'x-is-human': 'abc' } },
    });
  });

  it('prefers the classification reason and labels other outcomes', async () => {
    register({ ...BOT, classificationReason: 'headless' });
    expect((await verifyBotId())?.reason).toBe('headless');
    register(BOT);
    expect((await verifyBotId())?.reason).toBe('bot');
    register(HUMAN);
    expect((await verifyBotId())?.reason).toBe('human');
    register({ ...HUMAN, bypassed: true });
    expect((await verifyBotId())?.reason).toBe('bypassed');
    expect(seen.at(-1)).toEqual({});
  });
});

describe('botIdGuard', () => {
  it('rejects bots with FORBIDDEN inside safeAction', async () => {
    register(BOT);
    const action = safeAction({ guards: [botIdGuard()], handler: async () => 'done' });
    const result = await action(undefined as never);
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    register(HUMAN);
    expect(await action(undefined as never)).toEqual({ ok: true, data: 'done' });
  });

  it('lets verified bots through only when allowed', async () => {
    register(GOOGLEBOT);
    expect(await botIdGuard()({})).toBeInstanceOf(ActionError);
    expect(await botIdGuard({ allowVerifiedBots: true })({})).toBeUndefined();
  });

  it('uses the configured check level and forwards the action headers', async () => {
    register(HUMAN);
    const config = loadConfig({ vercel: { botId: { checkLevel: 'deepAnalysis' } } });
    await botIdGuard({ config })({ headers: new Headers({ 'user-agent': 'x' }) });
    expect(seen[0]).toEqual({
      advancedOptions: { checkLevel: 'deepAnalysis', headers: { 'user-agent': 'x' } },
    });
  });

  it('handles an unavailable BotID according to onUnavailable', async () => {
    const log = captureLogger();
    const denied = await botIdGuard({ onUnavailable: 'deny', log })({});
    expect(denied).toBeInstanceOf(ActionError);
    expect((denied as ActionError).code).toBe('FORBIDDEN');
    expect(await botIdGuard({ onUnavailable: 'allow', log })({})).toBeUndefined();
    register(new Error('network'));
    expect(await botIdGuard({ onUnavailable: 'allow', log })({})).toBeUndefined();
    // NODE_ENV is "test" here, so the default is to deny.
    expect(await botIdGuard({ log })({})).toBeInstanceOf(ActionError);
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });
});
