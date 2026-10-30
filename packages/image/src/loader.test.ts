import { afterEach, describe, expect, it } from 'vitest';
import cloudflareLoaderDefault, {
  buildCdnCgiUrl,
  buildNextImageUrl,
  cloudflareLoader,
  configureImageLoader,
  getImageLoaderConfig,
  isCdnCgiEnabled,
  isPassthroughSource,
  resetInlinedImageConfig,
} from './loader';

afterEach(() => {
  configureImageLoader(null);
  delete process.env.HYPDRIV_IMAGES;
  resetInlinedImageConfig();
  delete (globalThis as { __HYPDRIV_IMAGE_CDN_CGI__?: boolean }).__HYPDRIV_IMAGE_CDN_CGI__;
});

describe('buildCdnCgiUrl', () => {
  it('builds stable option order for local sources', () => {
    expect(buildCdnCgiUrl({ src: '/hero.jpg', width: 640, quality: 75 })).toBe(
      '/cdn-cgi/image/width=640,quality=75,format=auto,fit=scale-down/hero.jpg',
    );
    expect(buildCdnCgiUrl({ src: 'images/a b/ü.png', width: 320.4 })).toBe(
      '/cdn-cgi/image/width=320,quality=75,format=auto,fit=scale-down/images/a%20b/%C3%BC.png',
    );
    expect(buildCdnCgiUrl({ src: '/already%20encoded.png?v=2', width: 10 })).toContain(
      '/already%20encoded.png?v=2',
    );
  });

  it('keeps absolute URLs intact and supports all options', () => {
    expect(
      buildCdnCgiUrl({
        src: 'https://cdn.example.com/a/b.jpg?x=1',
        width: 100,
        height: 50,
        quality: 150,
        format: 'avif',
        fit: 'cover',
        dpr: 2,
        sharpen: 1.5,
        blur: 20,
        gravity: 'face',
        metadata: 'none',
        origin: 'https://images.example.com/',
      }),
    ).toBe(
      'https://images.example.com/cdn-cgi/image/width=100,height=50,quality=100,format=avif,fit=cover,dpr=2,sharpen=1.5,blur=20,gravity=face,metadata=none/https://cdn.example.com/a/b.jpg?x=1',
    );
    expect(buildCdnCgiUrl({ src: '/x.png', width: 0, quality: 0, dpr: 9, blur: 999 })).toBe(
      '/cdn-cgi/image/width=1,quality=1,format=auto,fit=scale-down,dpr=3,blur=250/x.png',
    );
  });
});

describe('buildNextImageUrl', () => {
  it('encodes the source and clamps quality', () => {
    expect(buildNextImageUrl({ src: '/hero.jpg', width: 640, quality: 75 })).toBe(
      '/_next/image?url=%2Fhero.jpg&w=640&q=75',
    );
    expect(buildNextImageUrl({ src: 'https://a.b/c d.png', width: 48 })).toBe(
      '/_next/image?url=https%3A%2F%2Fa.b%2Fc%20d.png&w=48&q=75',
    );
    expect(buildNextImageUrl({ src: '/x.png', width: 1, quality: 500, basePath: '/app/' })).toBe(
      '/app/_next/image?url=%2Fx.png&w=1&q=100',
    );
  });
});

describe('cloudflareLoader', () => {
  it('is the default export and follows the global configuration', () => {
    expect(cloudflareLoaderDefault).toBe(cloudflareLoader);
    // vitest runs with NODE_ENV=test → auto resolves to the Next optimiser
    expect(isCdnCgiEnabled()).toBe(false);
    expect(cloudflareLoader({ src: '/hero.jpg', width: 640, quality: 80 })).toBe(
      '/_next/image?url=%2Fhero.jpg&w=640&q=80',
    );

    configureImageLoader({ cdnCgi: true });
    expect(isCdnCgiEnabled()).toBe(true);
    expect(cloudflareLoader({ src: '/hero.jpg', width: 640 })).toBe(
      '/cdn-cgi/image/width=640,quality=75,format=auto,fit=scale-down/hero.jpg',
    );

    configureImageLoader({
      quality: 60,
      format: 'webp',
      fit: 'contain',
      origin: 'https://img.example.com',
      options: { sharpen: 1 },
    });
    expect(getImageLoaderConfig()).toMatchObject({ cdnCgi: true, quality: 60 });
    expect(cloudflareLoader({ src: 'https://other.test/p.jpg', width: 200 })).toBe(
      'https://img.example.com/cdn-cgi/image/width=200,quality=60,format=webp,fit=contain,sharpen=1/https://other.test/p.jpg',
    );

    configureImageLoader({ cdnCgi: false, basePath: '/docs' });
    expect(cloudflareLoader({ src: '/p.jpg', width: 200 })).toBe('/docs/_next/image?url=%2Fp.jpg&w=200&q=60');
  });

  it('honours the legacy kill switch and passes through data/blob/svg sources', () => {
    configureImageLoader({ cdnCgi: true });
    (globalThis as { __HYPDRIV_IMAGE_CDN_CGI__?: boolean }).__HYPDRIV_IMAGE_CDN_CGI__ = false;
    expect(isCdnCgiEnabled()).toBe(false);
    expect(cloudflareLoader({ src: '/a.png', width: 10 })).toContain('/_next/image');
    for (const src of [
      'data:image/png;base64,AAAA',
      'blob:https://x/y',
      '/logo.svg',
      'https://a.b/logo.SVG?x=1',
    ]) {
      expect(isPassthroughSource(src)).toBe(true);
      expect(cloudflareLoader({ src, width: 10 })).toBe(src);
    }
    expect(isPassthroughSource('/photo.jpg')).toBe(false);
  });

  it('configureImageLoader(null) resets', () => {
    configureImageLoader({ cdnCgi: true });
    configureImageLoader(null);
    expect(getImageLoaderConfig()).toEqual({});
  });
});

describe('build-time configuration (env.HYPDRIV_IMAGES)', () => {
  it('reads the JSON that withHypDriv inlines and lets the global override it', () => {
    process.env.HYPDRIV_IMAGES = JSON.stringify({ cdnCgi: true, quality: 82, basePath: '/shop' });
    resetInlinedImageConfig();
    expect(getImageLoaderConfig()).toEqual({ cdnCgi: true, quality: 82, basePath: '/shop' });
    expect(cloudflareLoader({ src: '/a.png', width: 320 })).toBe('/cdn-cgi/image/width=320,quality=82,format=auto,fit=scale-down/a.png');
    configureImageLoader({ cdnCgi: false });
    expect(getImageLoaderConfig()).toMatchObject({ cdnCgi: false, quality: 82 });
  });

  it('ignores malformed values', () => {
    process.env.HYPDRIV_IMAGES = '{not json';
    resetInlinedImageConfig();
    expect(getImageLoaderConfig()).toEqual({});
  });
});
