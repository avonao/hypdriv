import { resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { makeCtx, runStage } from './__tests__/helpers';
import { evaluateShield, shieldStage } from './shield';

const config = resolveConfig({
  site: { origin: 'https://app.test' },
  security: { shield: { enforceHost: true } },
});
const shield = config.security.shield!;
const stage = shieldStage(config);

describe('shieldStage', () => {
  it('runs on internal paths and passes ordinary requests', async () => {
    expect(stage.runOnInternal).toBe(true);
    const headerless = makeCtx({ config, url: 'https://app.test/page', host: false });
    expect(headerless.request.headers.get('host')).toBeNull();
    expect((await runStage(stage, headerless, () => new Response('ok'))).shortCircuited).toBe(false);
    const evilHeaderless = makeCtx({ config, url: 'https://evil.test/page', host: false });
    expect((await runStage(stage, evilHeaderless, () => new Response('ok'))).response.status).toBe(421);
    const ctx = makeCtx({ config, url: 'https://app.test/_next/static/a.js' });
    expect((await runStage(stage, ctx, () => new Response('ok'))).shortCircuited).toBe(false);
  });

  const rejections: Array<[string, Parameters<typeof makeCtx>[0], number, string?]> = [
    [
      'disallowed method',
      { config, method: 'PROPFIND' },
      405,
      'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    ],
    ['url too long', { config, url: `https://app.test/${'a'.repeat(9000)}` }, 414],
    ['encoded traversal', { config, url: 'https://app.test/static/..%2f..%2fetc/passwd' }, 400],
    ['null byte', { config, url: 'https://app.test/a%00.png' }, 400],
    ['blocked path .env', { config, url: 'https://app.test/.env' }, 404],
    ['blocked backup file', { config, url: 'https://app.test/db/dump.sql' }, 404],
    ['wrong host', { config, url: 'https://evil.test/', headers: { host: 'evil.test' } }, 421],
    [
      'body over the api limit',
      {
        config,
        url: 'https://app.test/api/upload',
        method: 'POST',
        headers: { 'content-length': String(2 * 1000 * 1000) },
      },
      413,
    ],
  ];
  it.each(rejections)('rejects: %s', async (_name, options, status, allow) => {
    const ctx = makeCtx(options);
    const { response, shortCircuited } = await runStage(stage, ctx, () => new Response('ok'));
    expect(shortCircuited).toBe(true);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    if (allow) expect(response.headers.get('allow')).toBe(allow);
  });

  it('allows large bodies on non-api routes under the global limit and ports/wildcards on hosts', () => {
    const big = makeCtx({
      config,
      url: 'https://app.test/upload',
      method: 'POST',
      headers: { 'content-length': String(5 * 1000 * 1000) },
    });
    expect(
      evaluateShield(shield, { request: big.request, url: big.url, siteOrigin: config.site.origin }),
    ).toBeNull();
    const wildcard = resolveConfig({ security: { shield: { enforceHost: ['*.app.test', 'app.test'] } } })
      .security.shield!;
    for (const host of ['app.test', 'www.app.test', 'app.test:8443']) {
      const ctx = makeCtx({ url: 'https://app.test/', headers: { host } });
      expect(evaluateShield(wildcard, { request: ctx.request, url: ctx.url, siteOrigin: null })).toBeNull();
    }
    const other = makeCtx({ url: 'https://app.test/', headers: { host: 'notapp.test' } });
    expect(
      evaluateShield(wildcard, { request: other.request, url: other.url, siteOrigin: null })?.status,
    ).toBe(421);
  });

  it('is a no-op when disabled', async () => {
    const off = resolveConfig({ security: { shield: false } });
    const ctx = makeCtx({ config: off, method: 'PROPFIND' });
    expect((await runStage(shieldStage(off), ctx, () => new Response('ok'))).shortCircuited).toBe(false);
  });
});
