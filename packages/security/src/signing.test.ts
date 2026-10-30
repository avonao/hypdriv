import { describe, expect, it } from 'vitest';
import {
  canonicalUrl,
  signInternalRequest,
  signUrl,
  signValue,
  verifyInternalRequest,
  verifyUrl,
  verifyValue,
} from './signing';

const SECRET = 'signing-secret-0123456789abcdef';

describe('signing', () => {
  it('signs and verifies URLs with expiry, independent of host and query order', async () => {
    const now = 1_700_000_000_000;
    const signed = await signUrl('https://app.test/download/report.pdf?b=2&a=1', SECRET, {
      expiresIn: 60,
      now,
    });
    const url = new URL(signed);
    expect(url.searchParams.get('exp')).toBe('1700000060');
    expect(url.searchParams.get('sig')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyUrl(signed, SECRET, { now })).toBe(true);
    expect(
      await verifyUrl(signed.replace('https://app.test', 'https://preview.app.test'), SECRET, { now }),
    ).toBe(true);
    const reordered = `https://app.test/download/report.pdf?sig=${url.searchParams.get('sig')}&exp=1700000060&a=1&b=2`;
    expect(await verifyUrl(reordered, SECRET, { now })).toBe(true);
    expect(await verifyUrl(signed, SECRET, { now: now + 61_000 })).toBe(false);
    expect(await verifyUrl(signed.replace('a=1', 'a=2'), SECRET, { now })).toBe(false);
    expect(await verifyUrl(signed.replace('exp=1700000060', 'exp=1900000000'), SECRET, { now })).toBe(false);
    expect(await verifyUrl(signed, 'other-secret-0123456789abcdef', { now })).toBe(false);
    expect(await verifyUrl('https://app.test/x', SECRET)).toBe(false);
    const custom = await signUrl(new URL('https://app.test/p'), SECRET, { param: 's' });
    expect(new URL(custom).searchParams.has('s')).toBe(true);
    expect(await verifyUrl(custom, SECRET, { param: 's' })).toBe(true);
    expect(canonicalUrl(new URL('https://x.test/p?z=1&a=2&sig=x'), 'sig')).toBe('/p?a=2&z=1');
  });

  it('signs and verifies values', async () => {
    const signed = await signValue('user:42', SECRET);
    expect(signed.startsWith('user:42.')).toBe(true);
    expect(await verifyValue(signed, SECRET)).toBe('user:42');
    expect(await verifyValue(`${signed}x`, SECRET)).toBeNull();
    expect(await verifyValue(`user:43.${signed.split('.')[1]}`, SECRET)).toBeNull();
    expect(await verifyValue('nodot', SECRET)).toBeNull();
    const dotted = await signValue('a.b.c', SECRET);
    expect(await verifyValue(dotted, SECRET)).toBe('a.b.c');
  });

  it('signs internal requests including the body and rejects replays outside the window', async () => {
    const now = 1_700_000_000_000;
    const request = new Request('https://app.test/api/jobs/cleanup?dry=1', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    const signed = await signInternalRequest(request, SECRET, now);
    expect(signed.headers.get('x-hypdriv-timestamp')).toBe('1700000000');
    expect(signed.headers.get('x-hypdriv-signature')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await signed.clone().text()).toBe('{"a":1}');
    expect(await verifyInternalRequest(signed, SECRET, { now })).toBe(true);
    expect(await verifyInternalRequest(signed, SECRET, { now: now + 299_000 })).toBe(true);
    expect(await verifyInternalRequest(signed, SECRET, { now: now + 301_000 })).toBe(false);
    expect(await verifyInternalRequest(signed, SECRET, { now, ttlSeconds: 1 })).toBe(true);
    expect(await verifyInternalRequest(signed, 'wrong-secret-0123456789abcdef', { now })).toBe(false);

    const tamperedBody = new Request(signed, { body: JSON.stringify({ a: 2 }), method: 'POST' });
    expect(await verifyInternalRequest(tamperedBody, SECRET, { now })).toBe(false);
    const tamperedPath = new Request('https://app.test/api/jobs/other?dry=1', {
      method: 'POST',
      headers: signed.headers,
      body: '{"a":1}',
    });
    expect(await verifyInternalRequest(tamperedPath, SECRET, { now })).toBe(false);
    const get = await signInternalRequest(new Request('https://app.test/api/jobs/ping'), SECRET, now);
    expect(await verifyInternalRequest(get, SECRET, { now })).toBe(true);
    expect(await verifyInternalRequest(new Request('https://app.test/api/jobs/ping'), SECRET, { now })).toBe(
      false,
    );
  });
});
