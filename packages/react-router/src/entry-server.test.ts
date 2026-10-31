import { createRequestHandler, RouterContextProvider, type ServerBuild } from 'react-router';
import { describe, expect, it } from 'vitest';
import { testBuild } from './__fixtures__/build';
import handleRequest, { createHandleRequest, streamTimeout } from './entry-server';

function buildWith(entry: unknown): ServerBuild {
  const build = testBuild({ middleware: false });
  return { ...build, entry: { module: { default: entry, streamTimeout } } } as unknown as ServerBuild;
}

const get = (path: string, init: RequestInit = {}) =>
  new Request(`https://app.example${path}`, { ...init, headers: { accept: 'text/html', ...init.headers } });

describe('entry.server', () => {
  it('renders without a nonce outside a HypDriv request', async () => {
    const rr = createRequestHandler(buildWith(handleRequest), 'production');
    const res = await rr(get('/page'), new RouterContextProvider());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    const html = await res.text();
    expect(html).toContain('<script');
    expect(html).not.toContain('nonce=');
  });

  it('puts the nonce on every script ServerRouter and React render', async () => {
    const rr = createRequestHandler(buildWith(createHandleRequest({ nonce: () => 'n0nce' })), 'production');
    const html = await (await rr(get('/page'), new RouterContextProvider())).text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(1);
    for (const tag of scripts) expect(tag).toContain('nonce="n0nce"');
    expect(html).toMatch(/<link rel="modulepreload" href="[^"]+" nonce="n0nce"/);
  });

  it('answers HEAD without a body and waits for everything when asked', async () => {
    let waited = 0;
    const rr = createRequestHandler(
      buildWith(
        createHandleRequest({
          waitForAll: () => {
            waited++;
            return true;
          },
        }),
      ),
      'production',
    );
    const head = await rr(get('/page', { method: 'HEAD' }), new RouterContextProvider());
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(waited).toBe(0);
    await (await rr(get('/page'), new RouterContextProvider())).text();
    expect(waited).toBe(1);
  });
});
