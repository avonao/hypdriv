import { describe, expect, it } from 'vitest';
import { deviceClass } from './device';
import { isSafeRedirect, safeRedirect } from './redirect';

const options = { origin: 'https://app.test', allowHosts: ['*.partner.test', 'docs.other.test'] };

describe('safeRedirect', () => {
  const cases: Array<[string, string]> = [
    ['/dashboard', '/dashboard'],
    ['/dashboard?next=1#top', '/dashboard?next=1#top'],
    ['  /trimmed ', '/trimmed'],
    ['https://app.test/account', 'https://app.test/account'],
    ['https://sub.partner.test/x', 'https://sub.partner.test/x'],
    ['https://partner.test/x', 'https://partner.test/x'],
    ['https://docs.other.test/', 'https://docs.other.test/'],
    ['//evil.test/path', '/'],
    ['/\\evil.test', '/'],
    ['\\\\evil.test', '/'],
    ['/path\\with\\backslash', '/'],
    ['/line\nbreak', '/'],
    ['/tab\there', '/'],
    ['javascript:alert(1)', '/'],
    ['data:text/html,hi', '/'],
    ['https://evil.test/', '/'],
    ['http://app.test/', '/'],
    ['https://user:pw@app.test/', '/'],
    ['https://app.test.evil.test/', '/'],
    ['https://notpartner.test/', '/'],
    ['evil.test/path', '/'],
    ['', '/'],
  ];
  it.each(cases)('%j → %j', (target, expected) => {
    expect(safeRedirect(target, options)).toBe(expected);
  });

  it('honours custom fallbacks, URL inputs and isSafeRedirect', () => {
    expect(safeRedirect('//evil.test', { origin: 'https://app.test', fallback: '/home' })).toBe('/home');
    expect(safeRedirect(new URL('https://app.test/a?b=1'), options)).toBe('https://app.test/a?b=1');
    expect(isSafeRedirect('/ok', options)).toBe(true);
    expect(isSafeRedirect('https://evil.test', options)).toBe(false);
    expect(safeRedirect('https://app.test/x', { origin: 'not a url' })).toBe('/');
  });
});

describe('deviceClass', () => {
  const h = (init: Record<string, string>) => new Headers(init);
  const CHROME =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  it('uses client hints first, then UA heuristics', () => {
    expect(deviceClass(h({ 'user-agent': CHROME, 'sec-ch-ua-mobile': '?1' }))).toBe('mobile');
    expect(deviceClass(h({ 'user-agent': CHROME, 'sec-ch-ua-mobile': '?0' }))).toBe('desktop');
    expect(deviceClass(h({ 'user-agent': CHROME }))).toBe('desktop');
    expect(
      deviceClass(
        h({
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        }),
      ),
    ).toBe('mobile');
    expect(
      deviceClass(
        h({
          'user-agent':
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Android"',
        }),
      ),
    ).toBe('mobile');
    expect(
      deviceClass(
        h({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }),
      ),
    ).toBe('bot');
    expect(deviceClass(h({ 'user-agent': 'curl/8.4.0' }))).toBe('bot');
    expect(deviceClass(h({}))).toBe('bot');
  });
});
