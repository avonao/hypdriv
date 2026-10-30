import { resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { makeCtx, runStage } from './__tests__/helpers';
import { buildSecurityHeaders, securityHeadersStage, serializePermissionsPolicy } from './headers';

const headersConfig = resolveConfig({}).security.headers!;

const EXPECTED_PERMISSIONS =
  'accelerometer=(), ambient-light-sensor=(), autoplay=(self), battery=(), camera=(), display-capture=(), document-domain=(), encrypted-media=(self), fullscreen=(self), geolocation=(), gyroscope=(), hid=(), idle-detection=(), interest-cohort=(), magnetometer=(), microphone=(), midi=(), payment=(self), picture-in-picture=(self), publickey-credentials-get=(self), screen-wake-lock=(), serial=(), usb=(), web-share=(self), xr-spatial-tracking=()';

describe('buildSecurityHeaders', () => {
  it('https production preset (exact map)', () => {
    expect(buildSecurityHeaders(headersConfig, { development: false, https: true, pathname: '/' })).toEqual({
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      'Cross-Origin-Resource-Policy': 'same-site',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': EXPECTED_PERMISSIONS,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'X-DNS-Prefetch-Control': 'on',
      'X-Permitted-Cross-Domain-Policies': 'none',
      'Origin-Agent-Cluster': '?1',
    });
  });

  it('development / http: no HSTS, everything else identical', () => {
    const dev = buildSecurityHeaders(headersConfig, { development: true, https: true, pathname: '/' });
    const http = buildSecurityHeaders(headersConfig, { development: false, https: false, pathname: '/' });
    expect(dev['Strict-Transport-Security']).toBeUndefined();
    expect(http['Strict-Transport-Security']).toBeUndefined();
    const { 'Strict-Transport-Security': _hsts, ...prod } = buildSecurityHeaders(headersConfig, {
      development: false,
      https: true,
      pathname: '/',
    });
    expect(dev).toEqual(prod);
    expect(http).toEqual(prod);
  });

  it('preload, COEP, extras and disabled entries', () => {
    const cfg = resolveConfig({
      security: {
        headers: {
          hsts: { maxAge: '1d', preload: true },
          coep: 'credentialless',
          frameOptions: false,
          permissionsPolicy: false,
          extra: { 'X-Custom': '1' },
        },
      },
    }).security.headers!;
    const h = buildSecurityHeaders(cfg, { development: false, https: true, pathname: '/' });
    expect(h['Strict-Transport-Security']).toBe('max-age=86400; includeSubDomains; preload');
    expect(h['Cross-Origin-Embedder-Policy']).toBe('credentialless');
    expect(h['X-Frame-Options']).toBeUndefined();
    expect(h['Permissions-Policy']).toBeUndefined();
    expect(h['X-Custom']).toBe('1');
  });

  it('route overrides merge over the base for the first matching pattern', () => {
    const cfg = resolveConfig({
      security: {
        headers: {
          routes: [
            {
              match: '/embed/**',
              headers: {
                frameOptions: 'SAMEORIGIN',
                corp: 'cross-origin',
                permissionsPolicy: { camera: ['self'] },
                hsts: false,
              },
            },
            { match: '/embed/special', headers: { frameOptions: false } },
          ],
        },
      },
    }).security.headers!;
    const h = buildSecurityHeaders(cfg, { development: false, https: true, pathname: '/embed/special' });
    expect(h['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(h['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    expect(h['Strict-Transport-Security']).toBeUndefined();
    expect(h['Permissions-Policy']).toContain('camera=(self)');
    expect(h['Permissions-Policy']).toContain('microphone=()');
    expect(
      buildSecurityHeaders(cfg, { development: false, https: true, pathname: '/other' })['X-Frame-Options'],
    ).toBe('DENY');
  });

  it('serialises permissions policies', () => {
    expect(
      serializePermissionsPolicy({
        geolocation: ['self', 'https://maps.test'],
        camera: [],
        fullscreen: ['*'],
        usb: ["'none'"],
      }),
    ).toBe('camera=(), fullscreen=*, geolocation=(self "https://maps.test"), usb=()');
  });
});

describe('securityHeadersStage', () => {
  it('applies headers, strips fingerprints, keeps app headers, runs on internal paths', async () => {
    const stage = securityHeadersStage(resolveConfig({}));
    expect(stage.runOnInternal).toBe(true);
    const ctx = makeCtx({ url: 'https://app.test/_next/static/chunk.js' });
    const { response } = await runStage(
      stage,
      ctx,
      () =>
        new Response('x', {
          headers: {
            'x-powered-by': 'Next.js',
            server: 'nginx',
            'x-opennext': '1',
            'referrer-policy': 'no-referrer',
            'content-type': 'text/javascript',
          },
        }),
    );
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('server')).toBeNull();
    expect(response.headers.get('x-opennext')).toBe('1');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-site');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
  });

  it('no HSTS in development and no-op when headers are disabled', async () => {
    const dev = makeCtx({ url: 'https://app.test/', development: true });
    const { response } = await runStage(securityHeadersStage(dev.config), dev);
    expect(response.headers.get('strict-transport-security')).toBeNull();
    expect(response.headers.get('x-frame-options')).toBe('DENY');

    const off = resolveConfig({ security: { headers: false } });
    const ctx = makeCtx({ config: off });
    const r = await runStage(
      securityHeadersStage(off),
      ctx,
      () => new Response('x', { headers: { 'x-powered-by': 'Next.js' } }),
    );
    expect(r.response.headers.get('x-powered-by')).toBe('Next.js');
    expect(r.response.headers.get('x-frame-options')).toBeNull();
  });
});
