import { emptyManifest } from '@hypdriv/core';
import { createHandler, ensureContextStore } from '@hypdriv/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import { hypdrivStart } from './start';

beforeAll(async () => {
  await ensureContextStore();
});

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html',
  'accept-language': 'en-US',
};

/** Runs `render` inside a pipeline request so the nonce is available, and returns what it produced. */
async function inRequest<T>(render: () => Promise<T>): Promise<{ result: T; nonce: string | undefined }> {
  const handler = createHandler({
    config: { site: { name: 'solid-test' } },
    manifest: emptyManifest({ buildId: 'test' }),
    host: 'solid-start',
    target: 'node',
  });
  let result: T | undefined;
  const response = await handler(new Request('https://shop.example/page', { headers: BROWSER }), {
    upstream: async () => {
      result = await render();
      return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    },
  });
  const nonce = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
  return { result: result as T, nonce };
}

describe('hypdrivStart', () => {
  it('hands the request nonce to Solid’s render options', async () => {
    const { result, nonce } = await inRequest(() => hypdrivStart()({}));
    expect(nonce).toBeTruthy();
    expect(result).toEqual({ nonce });
  });

  it('keeps the application’s options and function form', async () => {
    const { result, nonce } = await inRequest(() =>
      hypdrivStart(async (event: { path: string }) => ({ mode: 'async', path: event.path }))({ path: '/x' }),
    );
    expect(result).toEqual({ mode: 'async', path: '/x', nonce });
    const object = await inRequest(() => hypdrivStart({ mode: 'sync' })({}));
    expect(object.result).toEqual({ mode: 'sync', nonce: object.nonce });
  });

  it('never overrides a nonce the application set', async () => {
    const { result } = await inRequest(() => hypdrivStart({ nonce: 'mine' })({}));
    expect(result).toEqual({ nonce: 'mine' });
  });

  it('adds nothing outside a request (prerendering, build time)', async () => {
    expect(await hypdrivStart()({})).toEqual({});
    const options = { mode: 'sync' };
    expect(await hypdrivStart(options)({})).toBe(options);
  });
});
