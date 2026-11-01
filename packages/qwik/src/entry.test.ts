import { emptyManifest } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { asOrigin, FALLBACK_ORIGIN } from './adapters/common';
import { clientConnFor, HOST_LABEL, handlerFor, plainAddress } from './entry';

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html',
  'accept-language': 'en-US',
};

const options = (extra: Record<string, unknown> = {}) => ({
  config: { site: { name: 'entry-test' } },
  manifest: emptyManifest(),
  development: false,
  ...extra,
});

describe('plainAddress', () => {
  it('unwraps IPv4-mapped IPv6 addresses and leaves the rest alone', () => {
    expect(plainAddress('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(plainAddress('::FFFF:10.0.0.1')).toBe('10.0.0.1');
    expect(plainAddress('203.0.113.9')).toBe('203.0.113.9');
    expect(plainAddress('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('handlerFor', () => {
  it('creates the host handler with the Qwik label', async () => {
    const handler = handlerFor(options());
    expect(HOST_LABEL).toBe('qwik');
    expect(handler.config.site.name).toBe('entry-test');
    const response = await handler(
      new Request('https://shop.example/_hypdriv/health', { headers: BROWSER }),
      {
        upstream: async () => new Response('unreachable', { status: 500 }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runner: 'host', service: 'entry-test' });
  });

  it('runs the pipeline over what the upstream answers', async () => {
    const handler = handlerFor(options());
    const response = await handler(new Request('https://shop.example/', { headers: BROWSER }), {
      upstream: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    });
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain('nonce-');
  });
});

describe('clientConnFor', () => {
  const headers = { ip: 'x-real-ip', country: 'x-vercel-ip-country' };
  const request = (extra: Record<string, string> = {}) =>
    new Request('https://shop.example/', { headers: { ...BROWSER, ...extra } });

  it('reads the platform’s headers when no request is in flight', () => {
    expect(
      clientConnFor(request({ 'x-real-ip': '198.51.100.7', 'x-vercel-ip-country': 'US' }), headers),
    ).toEqual({
      ip: '198.51.100.7',
      country: 'US',
    });
    expect(clientConnFor(request(), headers)).toEqual({});
  });

  it('prefers what the Drivetrain resolved for the request', async () => {
    const handler = handlerFor(options());
    let seen: unknown;
    await handler(request({ 'x-real-ip': '198.51.100.7' }), {
      ip: '203.0.113.9',
      cf: { country: 'DE' },
      upstream: async (forwarded) => {
        seen = clientConnFor(forwarded, headers);
        return new Response('ok');
      },
    });
    expect(seen).toEqual({ ip: '203.0.113.9', country: 'DE' });
  });
});

describe('adapter origins', () => {
  it('turns a bare host into an https origin', () => {
    expect(asOrigin('shop.example')).toBe('https://shop.example');
    expect(asOrigin('https://shop.example')).toBe('https://shop.example');
    expect(asOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(asOrigin(undefined)).toBeUndefined();
    expect(asOrigin('')).toBeUndefined();
  });

  it('falls back to a placeholder origin for static generation', () => {
    expect(FALLBACK_ORIGIN).toBe('https://example.com');
  });
});
