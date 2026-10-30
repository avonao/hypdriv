import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BaseImageProps,
  createHypImage,
  defaultSizes,
  getPlaceholder,
  resetPlaceholders,
  withPlaceholders,
} from './index';

/** Stand-in for next/image: renders every prop as an attribute so assertions can read them back. */
function FakeImage(props: BaseImageProps & { 'data-extra'?: string }) {
  const { src, ...rest } = props;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest))
    if (v !== undefined) attrs[k] = typeof v === 'string' ? v : JSON.stringify(v);
  // biome-ignore lint/performance/noImgElement: this is the stand-in for next/image itself
  return <img alt="" src={typeof src === 'string' ? src : src.src} {...attrs} />;
}

const BLUR = 'data:image/webp;base64,UklGRg==';

afterEach(() => resetPlaceholders());

describe('createHypImage', () => {
  it('injects blur placeholders from the registry and sizes/decoding defaults', () => {
    withPlaceholders({ '/hero.jpg': BLUR, 'no-slash.png': BLUR });
    const HypImage = createHypImage(FakeImage);
    const html = renderToString(<HypImage src="/hero.jpg?v=3" width={1200} height={600} alt="hero" />);
    expect(html).toContain('placeholder="blur"');
    expect(html).toContain(`blurDataURL="${BLUR}"`);
    expect(html).toContain(`sizes="${defaultSizes(1200)}"`);
    expect(html).toContain('decoding="async"');
    expect(html).not.toContain('fetchPriority');
    expect(getPlaceholder('/no-slash.png')).toBe(BLUR);
    expect(getPlaceholder({ src: 'hero.jpg' })).toBe(BLUR);
    expect(getPlaceholder('/missing.png')).toBeUndefined();
  });

  it('uses 100vw for fill images, high fetch priority for priority images, and respects explicit props', () => {
    const HypImage = createHypImage(FakeImage, { placeholders: { '/a.png': BLUR } });
    const fill = renderToString(<HypImage src="/a.png" fill priority alt="" />);
    expect(fill).toContain('sizes="100vw"');
    expect(fill).toContain('fetchPriority="high"');
    expect(fill).toContain('placeholder="blur"');
    const explicit = renderToString(
      <HypImage
        src="/a.png"
        width={10}
        sizes="50vw"
        placeholder="empty"
        decoding="sync"
        fetchPriority="low"
        priority
        alt=""
      />,
    );
    expect(explicit).toContain('sizes="50vw"');
    expect(explicit).toContain('placeholder="empty"');
    expect(explicit).not.toContain('blurDataURL');
    expect(explicit).toContain('decoding="sync"');
    expect(explicit).toContain('fetchPriority="low"');
  });

  it('supports per-element maps, static imports, custom sizes and plain mode', () => {
    const HypImage = createHypImage(FakeImage, { sizes: (w) => `${w}px`, fillSizes: '90vw' });
    const perElement = renderToString(
      <HypImage src="/b.png" width={300} placeholders={{ '/b.png': BLUR }} alt="" />,
    );
    expect(perElement).toContain('placeholder="blur"');
    expect(perElement).toContain('sizes="300px"');
    expect(perElement).not.toContain('placeholders=');
    const imported = renderToString(
      <HypImage src={{ src: '/static.png', width: 400, height: 200, blurDataURL: BLUR }} alt="" />,
    );
    expect(imported).toContain('sizes="400px"');
    expect(imported).toContain('placeholder="blur"');
    const fill = renderToString(<HypImage src="/c.png" fill alt="" />);
    expect(fill).toContain('sizes="90vw"');
    expect(fill).not.toContain('placeholder=');
    const plain = renderToString(
      <HypImage src="/b.png" width={300} plain placeholders={{ '/b.png': BLUR }} alt="" />,
    );
    expect(plain).not.toContain('sizes=');
    expect(plain).not.toContain('decoding=');
    expect(HypImage.displayName).toBe('HypImage(FakeImage)');
  });

  it('withPlaceholders accepts the generated file shape and ignores non-data values', () => {
    const map = withPlaceholders({
      version: 1,
      generatedAt: 'now',
      size: 16,
      placeholders: { '/x.png': BLUR, '/bad.png': 'http://not-a-data-url' },
    });
    expect(map).toEqual({ '/x.png': BLUR });
    expect(withPlaceholders(null)).toEqual({ '/x.png': BLUR });
  });
});
