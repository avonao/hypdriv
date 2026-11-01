import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_SESSION_DEFAULT_TTL_SECONDS,
  DASHBOARD_SESSION_MAX_TTL_SECONDS,
  DASHBOARD_TOKEN_MIN_LENGTH,
  signDashboardSession,
  verifyDashboardSession,
  verifyDashboardToken,
} from './dashboard-session';
import { signPurgeToken } from './purge-token';

const SECRET = 'dashboard-access-token-0123456789';
const NOW = 1_800_000_000_000;

describe('verifyDashboardToken()', () => {
  it('accepts exactly the configured token', async () => {
    expect(await verifyDashboardToken(SECRET, SECRET)).toBe(true);
    expect(await verifyDashboardToken(`${SECRET}x`, SECRET)).toBe(false);
    expect(await verifyDashboardToken(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(await verifyDashboardToken('', SECRET)).toBe(false);
    expect(await verifyDashboardToken(null, SECRET)).toBe(false);
    expect(await verifyDashboardToken(SECRET, undefined)).toBe(false);
  });

  it('refuses a configured token that is too short, even when it matches', async () => {
    const short = 'x'.repeat(DASHBOARD_TOKEN_MIN_LENGTH - 1);
    expect(await verifyDashboardToken(short, short)).toBe(false);
    const ok = 'x'.repeat(DASHBOARD_TOKEN_MIN_LENGTH);
    expect(await verifyDashboardToken(ok, ok)).toBe(true);
  });

  it('refuses absurdly long input without hashing it', async () => {
    expect(await verifyDashboardToken('a'.repeat(5000), SECRET)).toBe(false);
  });
});

describe('dashboard sessions', () => {
  it('round-trips for the host it was minted for', async () => {
    const session = await signDashboardSession(SECRET, { host: 'Example.com', now: NOW });
    expect(session).toMatch(/^v1\.\d+\.[\w-]+$/);
    expect(await verifyDashboardSession(session, SECRET, { host: 'example.com', now: NOW + 1000 })).toBe(
      true,
    );
  });

  it('is bound to the host and the secret', async () => {
    const session = await signDashboardSession(SECRET, { host: 'example.com', now: NOW });
    expect(await verifyDashboardSession(session, SECRET, { host: 'evil.test', now: NOW })).toBe(false);
    expect(await verifyDashboardSession(session, `${SECRET}!`, { host: 'example.com', now: NOW })).toBe(
      false,
    );
  });

  it('expires, and a verifier caps the lifetime a cookie can claim', async () => {
    const session = await signDashboardSession(SECRET, { host: 'example.com', ttlSeconds: 60, now: NOW });
    expect(await verifyDashboardSession(session, SECRET, { host: 'example.com', now: NOW + 59_000 })).toBe(
      true,
    );
    expect(await verifyDashboardSession(session, SECRET, { host: 'example.com', now: NOW + 61_000 })).toBe(
      false,
    );
    const clamped = await signDashboardSession(SECRET, {
      host: 'example.com',
      ttlSeconds: 10 * 86_400,
      now: NOW,
    });
    const exp = Number(clamped.split('.')[1]);
    expect(exp - Math.floor(NOW / 1000)).toBe(DASHBOARD_SESSION_MAX_TTL_SECONDS);
    // A cookie forged with a far-future expiry is refused even with a valid signature shape.
    const long = await signDashboardSession(SECRET, { host: 'example.com', now: NOW });
    expect(
      await verifyDashboardSession(long, SECRET, {
        host: 'example.com',
        now: NOW - (DASHBOARD_SESSION_MAX_TTL_SECONDS + DASHBOARD_SESSION_DEFAULT_TTL_SECONDS) * 1000,
      }),
    ).toBe(false);
  });

  it('rejects tampering and malformed values', async () => {
    const session = await signDashboardSession(SECRET, { host: 'example.com', now: NOW });
    const [v, exp, sig] = session.split('.');
    for (const bad of [
      `${v}.${Number(exp) + 1}.${sig}`,
      `${v}.${exp}.${sig}A`,
      `v2.${exp}.${sig}`,
      `${v}.${exp}`,
      `${session}.extra`,
      'x'.repeat(300),
      '',
    ])
      expect(await verifyDashboardSession(bad, SECRET, { host: 'example.com', now: NOW })).toBe(false);
    expect(await verifyDashboardSession(null, SECRET, { host: 'example.com', now: NOW })).toBe(false);
    expect(await verifyDashboardSession(session, 'short', { host: 'example.com', now: NOW })).toBe(false);
  });

  it('is not interchangeable with a purge token', async () => {
    const purge = await signPurgeToken(SECRET, { host: 'example.com', now: NOW });
    expect(await verifyDashboardSession(purge, SECRET, { host: 'example.com', now: NOW })).toBe(false);
  });
});
