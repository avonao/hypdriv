import { describe, expect, it, vi } from 'vitest';
import {
  createQwikFetch,
  DEFAULT_REQUEST_BODY_LIMIT,
  errorResponse,
  limitRequestBody,
  notFoundResponse,
} from './fetch';

const post = (body: string | Uint8Array) =>
  new Request('https://shop.example/action/', { method: 'POST', body, duplex: 'half' } as RequestInit);

describe('limitRequestBody', () => {
  it('passes a request without a body through', () => {
    const request = new Request('https://shop.example/');
    expect(limitRequestBody(request, 10)).toBe(request);
  });

  it('delivers a body within the limit unchanged', async () => {
    const limited = limitRequestBody(post('twelve bytes'), 12);
    expect(await limited.text()).toBe('twelve bytes');
    expect(limited.method).toBe('POST');
    expect(limited.url).toBe('https://shop.example/action/');
  });

  it('fails reading once the body crosses the limit', async () => {
    const limited = limitRequestBody(post('thirteen bytes'), 12);
    await expect(limited.text()).rejects.toMatchObject({ status: 413 });
  });

  it('counts the chunks together', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    const request = new Request('https://shop.example/', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    await expect(limitRequestBody(request, 12).arrayBuffer()).rejects.toMatchObject({ status: 413 });
  });
});

describe('createQwikFetch', () => {
  it('uses Qwik’s default body limit of 10 MiB', () => {
    expect(DEFAULT_REQUEST_BODY_LIMIT).toBe(10 * 1024 * 1024);
  });

  it('rejects a body limit that is not a positive safe integer', () => {
    for (const requestBodyLimit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => createQwikFetch({ render: async () => ({}) as never, requestBodyLimit })).toThrow(
        TypeError,
      );
  });

  it('builds a handler for a valid configuration', () => {
    expect(typeof createQwikFetch({ render: async () => ({}) as never, requestBodyLimit: 1024 })).toBe(
      'function',
    );
  });
});

describe('notFoundResponse', () => {
  it('answers browsers with an HTML page and everything else with plain text', async () => {
    const page = notFoundResponse(
      new Request('https://shop.example/missing/', {
        headers: { accept: 'text/html,application/xhtml+xml' },
      }),
    );
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Not Found');
    expect(page.headers.get('x-not-found')).toBe('/missing/');

    const api = notFoundResponse(
      new Request('https://shop.example/api/x', { headers: { accept: 'application/json' } }),
    );
    expect(api.status).toBe(404);
    expect(await api.text()).toBe('Not Found');
  });
});

describe('errorResponse', () => {
  it('answers 500, names the source and logs the error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = errorResponse(new Error('boom'), 'node');
    expect(response.status).toBe(500);
    expect(response.headers.get('x-error')).toBe('node');
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(log).toHaveBeenCalledOnce();
    // Qwik's `isDev` decides whether the message is shown; production builds say `Internal Server Error`.
    expect(await response.text()).toMatch(/boom|Internal Server Error/);
    log.mockRestore();
  });
});
