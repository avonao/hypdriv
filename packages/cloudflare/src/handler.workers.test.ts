import { emptyManifest } from '@hypdriv/core';
import { createHandler } from '@hypdriv/runtime';
import { describe, expect, it } from 'vitest';

// Hosts whose framework does not hand Hypdriv the Worker's `env` (adapter entries, in-app hooks) read the bindings
// from `cloudflare:workers`. The import specifier is computed at run time; this proves workerd still resolves it.
describe('createHandler in workerd without an explicit env', () => {
  it('reads the bindings from cloudflare:workers', async () => {
    const handler = createHandler({ config: {}, manifest: emptyManifest(), host: 'test' });
    const response = await handler(new Request('https://shop.example.com/_hypdriv/health'), {
      upstream: () => new Response('app'),
    });
    expect(response.status).toBe(200);
    const health = (await response.json()) as { target: string; capabilities: string[] };
    expect(health.target).toBe('cloudflare');
    expect(health.capabilities).toContain('rate limiting: exact (Durable Object)');
  });
});
