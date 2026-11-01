import { ensureContextStore } from '@hypdriv/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import hypdrivNitroPlugin from './nitro';
import type { NitroAppLike } from './nitro-hook';

// `virtual:hypdriv/config|manifest|solid-start` resolve to src/__fixtures__ in this package's vitest config.

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html',
  'accept-language': 'en-US',
};

beforeAll(async () => {
  await ensureContextStore();
});

const page = (body = '<script>boot()</script>') =>
  new Response(`<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

describe('the Nitro runtime plugin', () => {
  it('wraps nitroApp.fetch with the Drivetrain configured by the virtual modules', async () => {
    const app: NitroAppLike = { fetch: async () => page() };
    hypdrivNitroPlugin(app);

    const health = await app.fetch(new Request('https://shop.example/_hypdriv/health', { headers: BROWSER }));
    expect(await health.json()).toMatchObject({
      runner: 'host',
      target: 'node',
      framework: expect.stringContaining('SolidStart'),
    });

    // A dynamic page of the manifest gets a nonce policy and nonce-stamped inline scripts.
    const dynamic = await app.fetch(new Request('https://shop.example/request', { headers: BROWSER }));
    const csp = dynamic.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(dynamic.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(nonce).toBeTruthy();
    expect(await dynamic.text()).toContain(`<script nonce="${nonce}">boot()</script>`);
  });

  it('applies the hash policy of a prerendered page Nitro serves itself', async () => {
    const app: NitroAppLike = { fetch: async () => page() };
    hypdrivNitroPlugin(app);
    const about = await app.fetch(new Request('https://shop.example/about', { headers: BROWSER }));
    expect(about.headers.get('x-hypdriv-csp')).toBe('hash');
    expect(about.headers.get('content-security-policy')).toContain("'sha256-fixture'");
    // The document is Nitro's file, byte for byte.
    expect(await about.text()).toBe(await page().text());
  });

  it('skips the content-hashed assets prefix and hides build metadata', async () => {
    let calls = 0;
    const app: NitroAppLike = {
      fetch: async () => {
        calls++;
        return new Response('x', { headers: { 'content-type': 'application/octet-stream' } });
      },
    };
    hypdrivNitroPlugin(app);
    const asset = await app.fetch(
      new Request('https://shop.example/_build/assets/chunk', { headers: { ...BROWSER, accept: '*/*' } }),
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get('x-hypdriv-request-id')).toBeNull();
    expect((await app.fetch(new Request('https://shop.example/.vite/manifest.json'))).status).toBe(404);
    expect(calls).toBe(1);
  });

  it('answers an application error with a JSON 500 that carries the request id', async () => {
    const app: NitroAppLike = {
      fetch: async () => {
        throw new Error('secret detail');
      },
    };
    hypdrivNitroPlugin(app);
    const response = await app.fetch(new Request('https://shop.example/request', { headers: BROWSER }));
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { error: string; requestId: string | null; message?: string };
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toBeTruthy();
    // Not in development: the error message stays server-side.
    expect(body.message).toBeUndefined();
  });
});
