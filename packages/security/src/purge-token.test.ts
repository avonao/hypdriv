import { describe, expect, it } from 'vitest';
import { signAuditToken } from './audit-token';
import { PURGE_TOKEN_MAX_TTL_SECONDS, signPurgeToken, verifyPurgeToken } from './purge-token';

const SECRET = 'internal-secret-for-tests-0123456789';
const NOW = 1_800_000_000_000;

describe('signPurgeToken / verifyPurgeToken', () => {
  it('round-trips for the same host within the lifetime', async () => {
    const token = await signPurgeToken(SECRET, { host: 'www.example.com', now: NOW, ttlSeconds: 60 });
    expect(token).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/);
    expect(await verifyPurgeToken(token, SECRET, { host: 'www.example.com', now: NOW })).toBe(true);
    expect(await verifyPurgeToken(token, SECRET, { host: 'WWW.EXAMPLE.COM', now: NOW + 59_000 })).toBe(true);
  });

  it('rejects another host, another secret, an expired and a tampered token', async () => {
    const token = await signPurgeToken(SECRET, { host: 'www.example.com', now: NOW, ttlSeconds: 60 });
    expect(await verifyPurgeToken(token, SECRET, { host: 'evil.example.com', now: NOW })).toBe(false);
    expect(await verifyPurgeToken(token, `${SECRET}x`, { host: 'www.example.com', now: NOW })).toBe(false);
    expect(await verifyPurgeToken(token, SECRET, { host: 'www.example.com', now: NOW + 61_000 })).toBe(false);
    const [v, exp, sig] = token.split('.');
    expect(
      await verifyPurgeToken(`${v}.${Number(exp) + 1}.${sig}`, SECRET, { host: 'www.example.com', now: NOW }),
    ).toBe(false);
    expect(await verifyPurgeToken('', SECRET, { host: 'www.example.com' })).toBe(false);
    expect(await verifyPurgeToken(null, SECRET, { host: 'www.example.com' })).toBe(false);
    expect(await verifyPurgeToken('v1.1.2.3', SECRET, { host: 'www.example.com' })).toBe(false);
  });

  it('caps the lifetime at five minutes, signing and verifying', async () => {
    const long = await signPurgeToken(SECRET, { host: 'a.example.com', now: NOW, ttlSeconds: 86_400 });
    const exp = Number(long.split('.')[1]);
    expect(exp - Math.floor(NOW / 1000)).toBe(PURGE_TOKEN_MAX_TTL_SECONDS);
    const forged = `v1.${Math.floor(NOW / 1000) + 3600}.${long.split('.')[2]}`;
    expect(await verifyPurgeToken(forged, SECRET, { host: 'a.example.com', now: NOW })).toBe(false);
  });

  it('is not interchangeable with an audit token', async () => {
    const audit = await signAuditToken(SECRET, { host: 'a.example.com', now: NOW, ttlSeconds: 60 });
    expect(await verifyPurgeToken(audit, SECRET, { host: 'a.example.com', now: NOW })).toBe(false);
  });
});
