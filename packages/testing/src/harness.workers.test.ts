import { defineStage } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { createFakeKV } from './fakes/kv';
import { createTestContext, expectHeaders, requestWithCf, runStage } from './harness';

/** An edge-only stage that rewrites HTML with HTMLRewriter (only available inside workerd). */
const titleStage = defineStage({
  name: 'title',
  edgeOnly: true,
  post(ctx, response) {
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;
    const country = ctx.cf?.country ?? 'XX';
    return new HTMLRewriter()
      .on('title', {
        element(el) {
          el.setInnerContent(`HypDriv (${country})`);
        },
      })
      .on('html', {
        element(el) {
          el.setAttribute('data-request', ctx.id);
        },
      })
      .transform(response);
  },
});

describe('@hypdriv/testing inside workerd', () => {
  it('createTestContext + runStage work with HTMLRewriter', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
    const ctx = createTestContext({
      url: 'https://app.test/',
      cf: { country: 'US' },
      id: 'req-42',
      runner: 'worker',
    });
    const result = await runStage(
      titleStage,
      ctx,
      () =>
        new Response('<html><head><title>x</title></head><body>hi</body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
    expect(result.shortCircuited).toBe(false);
    const html = await result.response.text();
    expect(html).toContain('<title>HypDriv (US)</title>');
    expect(html).toContain('<html data-request="req-42">');
    expectHeaders(result.response, { 'content-type': 'text/html', 'x-missing': null });
    expect(result.timings.map((t) => t.name)).toEqual(['next', 'title.post']);
  });

  it('fakes and request helpers behave the same as in Node', async () => {
    const kv = createFakeKV();
    await kv.put('k', 'v', { expirationTtl: 60 });
    expect(await kv.get('k')).toBe('v');
    const request = requestWithCf('https://app.test/x', {}, { colo: 'SJC' });
    expect(request.cf.colo).toBe('SJC');
    expect(typeof caches).toBe('object');
  });
});
