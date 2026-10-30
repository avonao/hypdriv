import { describe, expect, it } from 'vitest';
import { MAX_TAG_BYTES, pathTag, routeTag, sanitizeTag, sanitizeTags } from './tags';

const escapedLength = (tag: string) => tag.length + [...tag].filter((c) => c === '"' || c === '\\').length;

describe('sanitizeTag', () => {
  it('keeps ordinary tags unchanged (case-sensitive)', () => {
    expect(sanitizeTag('posts')).toBe('posts');
    expect(sanitizeTag('Product-123')).toBe('Product-123');
    expect(sanitizeTag('route:app:/blog/[slug]')).toBe('route:app:/blog/[slug]');
  });

  it('trims, and percent-encodes commas, whitespace, control and non-ASCII characters', () => {
    expect(sanitizeTag('  a,b  ')).toBe('a%2Cb');
    expect(sanitizeTag('two words')).toBe('two%20words');
    expect(sanitizeTag('tab\there')).toBe('tab%09here');
    expect(sanitizeTag('café')).toBe('caf%C3%A9');
    expect(sanitizeTag('\u{1F680}')).toBe('%F0%9F%9A%80');
    expect(sanitizeTag('lone\uD800')).toBe('lone%EF%BF%BD');
    expect(sanitizeTag('   ')).toBeNull();
  });

  it('shortens tags over 256 escaped bytes deterministically', () => {
    const long = `hyp:path:/${'segment/'.repeat(60)}`;
    const a = sanitizeTag(long)!;
    expect(a.length).toBeLessThanOrEqual(MAX_TAG_BYTES);
    expect(a).toMatch(/^hyp:path:\/segment\/.*~[0-9a-z]+$/);
    expect(sanitizeTag(long)).toBe(a);
    expect(sanitizeTag(`${long}x`)).not.toBe(a);
    const quoted = '"\\'.repeat(200);
    expect(escapedLength(sanitizeTag(quoted)!)).toBeLessThanOrEqual(MAX_TAG_BYTES);
    const encoded = 'é'.repeat(100);
    const shortened = sanitizeTag(encoded)!;
    expect(shortened.length).toBeLessThanOrEqual(MAX_TAG_BYTES);
    expect(shortened).toMatch(/^(%C3%A9)+~/);
  });
});

describe('sanitizeTags / tag builders', () => {
  it('de-duplicates after sanitising and caps the count', () => {
    expect(sanitizeTags(['a', ' a ', 'b', '', 'a,'])).toEqual(['a', 'b', 'a%2C']);
    expect(sanitizeTags(['x', 'y', 'z'], 2)).toEqual(['x', 'y']);
  });

  it('builds path and route tags', () => {
    expect(pathTag('/blog/hello')).toBe('hyp:path:/blog/hello');
    expect(pathTag('')).toBe('hyp:path:/');
    expect(routeTag('app:/blog/[slug]')).toBe('hyp:route:app:/blog/[slug]');
  });
});
