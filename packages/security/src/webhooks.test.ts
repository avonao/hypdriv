import { base64Encode, hexEncode, hmacSign, utf8Encode } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import {
  standardWebhookHeaders,
  standardWebhookKey,
  verifyGitHub,
  verifyStandard,
  verifyStripe,
} from './webhooks';

const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
const now = 1_700_000_000_000;

describe('webhooks', () => {
  it('Stripe: t/v1 scheme with tolerance and multiple signatures', async () => {
    const secret = 'whsec_test_secret_value';
    const ts = Math.floor(now / 1000);
    const sig = hexEncode(await hmacSign(secret, `${ts}.${payload}`));
    const header = `t=${ts},v1=deadbeef,v1=${sig}`;
    expect(await verifyStripe(payload, header, secret, 300, now)).toBe(true);
    expect(await verifyStripe(payload, `t=${ts},v1=${sig.toUpperCase()}`, secret, 300, now)).toBe(true);
    expect(await verifyStripe(payload, header, secret, 300, now + 301_000)).toBe(false);
    expect(await verifyStripe(payload, header, secret, 600, now + 301_000)).toBe(true);
    expect(await verifyStripe(`${payload} `, header, secret, 300, now)).toBe(false);
    expect(await verifyStripe(payload, header, 'whsec_other', 300, now)).toBe(false);
    expect(await verifyStripe(payload, `t=${ts}`, secret, 300, now)).toBe(false);
    expect(await verifyStripe(payload, `v1=${sig}`, secret, 300, now)).toBe(false);
    expect(await verifyStripe('', header, secret, 300, now)).toBe(false);
  });

  it('GitHub: sha256= HMAC over the raw body', async () => {
    const secret = 'gh-webhook-secret';
    const sig = `sha256=${hexEncode(await hmacSign(secret, payload))}`;
    expect(await verifyGitHub(payload, sig, secret)).toBe(true);
    expect(await verifyGitHub(payload, sig.toUpperCase().replace('SHA256=', 'sha256='), secret)).toBe(true);
    expect(await verifyGitHub(payload, sig.slice(7), secret)).toBe(true);
    expect(await verifyGitHub(`${payload}x`, sig, secret)).toBe(false);
    expect(await verifyGitHub(payload, sig, 'other')).toBe(false);
    expect(await verifyGitHub(payload, '', secret)).toBe(false);
  });

  it('Standard Webhooks: whsec_ base64 secret, msg_id.timestamp.payload, v1 list', async () => {
    const rawKey = new Uint8Array(24).map((_, i) => i * 7);
    const secret = `whsec_${base64Encode(rawKey)}`;
    expect([...standardWebhookKey(secret)]).toEqual([...rawKey]);
    const id = 'msg_2Kq';
    const timestamp = String(Math.floor(now / 1000));
    const expected = base64Encode(await hmacSign(rawKey, `${id}.${timestamp}.${payload}`));
    const headers = { id, timestamp, signature: `v1,bogus= v1,${expected}` };
    expect(await verifyStandard(payload, headers, secret, 300, now)).toBe(true);
    expect(await verifyStandard(payload, headers, secret, 300, now + 400_000)).toBe(false);
    expect(await verifyStandard(payload, { ...headers, id: 'msg_other' }, secret, 300, now)).toBe(false);
    expect(await verifyStandard(payload, { ...headers, signature: 'v2,xyz' }, secret, 300, now)).toBe(false);
    expect(await verifyStandard(payload, { ...headers, timestamp: 'abc' }, secret, 300, now)).toBe(false);
    // raw (non-base64) secrets are used as UTF-8 bytes
    const rawSecret = 'plain text secret!';
    const sig2 = base64Encode(await hmacSign(utf8Encode(rawSecret), `${id}.${timestamp}.${payload}`));
    expect(
      await verifyStandard(payload, { id, timestamp, signature: `v1,${sig2}` }, rawSecret, 300, now),
    ).toBe(true);
    expect(
      standardWebhookHeaders(new Headers({ 'svix-id': 'a', 'svix-timestamp': 'b', 'svix-signature': 'c' })),
    ).toEqual({ id: 'a', timestamp: 'b', signature: 'c' });
  });
});
