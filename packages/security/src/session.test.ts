import { utf8Decode } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { decrypt, decryptToString, encrypt, keyId, parseEncryptedToken } from './crypto';
import { createSessionStore } from './session';

const SECRET = 'current-secret-that-is-definitely-long-enough';
const OLD = 'previous-secret-that-is-also-long-enough';

describe('encrypt / decrypt', () => {
  it('round-trips with the v1 token format and a stable kid', async () => {
    const token = await encrypt(SECRET, 'hello world', 'ctx');
    const kid = await keyId(SECRET);
    expect(token).toMatch(new RegExp(`^v1\\.${kid}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]+$`));
    expect(parseEncryptedToken(token)?.kid).toBe(kid);
    expect(utf8Decode((await decrypt(SECRET, token, 'ctx'))!)).toBe('hello world');
    expect(await decryptToString([OLD, SECRET], token, 'ctx')).toBe('hello world');
    const bytes = await encrypt(SECRET, new Uint8Array([1, 2, 3]));
    expect([...(await decrypt(SECRET, bytes))!]).toEqual([1, 2, 3]);
  });

  it('detects tampering, wrong AAD, wrong secret and garbage', async () => {
    const token = await encrypt(SECRET, 'payload', 'aad');
    const parts = token.split('.');
    const ct = parts[3]!;
    const flipped = `${parts.slice(0, 3).join('.')}.${ct.slice(0, -2)}${ct.endsWith('A') ? 'BB' : 'AA'}`;
    expect(await decrypt(SECRET, flipped, 'aad')).toBeNull();
    expect(await decrypt(SECRET, token, 'other')).toBeNull();
    expect(await decrypt(SECRET, token)).toBeNull();
    expect(await decrypt(OLD, token, 'aad')).toBeNull();
    expect(await decrypt(SECRET, 'v1.deadbeef.short.x', 'aad')).toBeNull();
    expect(await decrypt(SECRET, 'not a token', 'aad')).toBeNull();
    expect(await decrypt(SECRET, token.replace('v1.', 'v2.'), 'aad')).toBeNull();
  });

  it('rejects weak secrets', async () => {
    await expect(encrypt('short', 'x')).rejects.toThrow(/at least 16/);
  });
});

describe('createSessionStore', () => {
  it('writes an HttpOnly cookie, reads it back and clears it', async () => {
    let now = 1_700_000_000_000;
    const store = createSessionStore<{ uid: string }>({
      secret: SECRET,
      ttlSeconds: 3600,
      now: () => now,
      domain: 'app.test',
    });
    const cookie = await store.write({ uid: 'u1' });
    expect(cookie).toMatch(/^hyp_session=v1\./);
    expect(cookie).toContain('Max-Age=3600');
    expect(cookie).toContain('Domain=app.test');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const value = cookie.split(';')[0]!.slice('hyp_session='.length);
    const read = await store.read(new Headers({ cookie: `other=1; hyp_session=${value}` }));
    expect(read).toEqual({
      data: { uid: 'u1' },
      expiresAt: now + 3600_000,
      needsRefresh: false,
      key: 'current',
    });
    expect(await store.read(new Headers())).toEqual({ data: null, expiresAt: null, needsRefresh: false });

    now += 1801_000; // past 50% of the ttl → sliding refresh
    expect((await store.read(new Headers({ cookie: `hyp_session=${value}` }))).needsRefresh).toBe(true);
    now += 1800_000; // expired
    expect((await store.read(new Headers({ cookie: `hyp_session=${value}` }))).data).toBeNull();

    expect(store.clear()).toMatch(
      /^hyp_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=app.test; Path=\/; Secure; SameSite=Lax$/,
    );
  });

  it('rotation: old cookies stay readable and ask for a refresh; sliding can be turned off', async () => {
    const old = createSessionStore<{ uid: string }>({ secret: OLD });
    const value = (await old.write({ uid: 'u2' })).split(';')[0]!.slice('hyp_session='.length);
    const rotated = createSessionStore<{ uid: string }>({ secret: [SECRET, OLD] });
    const read = await rotated.read(new Headers({ cookie: `hyp_session=${value}` }));
    expect(read.data).toEqual({ uid: 'u2' });
    expect(read.key).toBe('previous');
    expect(read.needsRefresh).toBe(true);
    const onlyNew = createSessionStore<{ uid: string }>({ secret: SECRET });
    expect((await onlyNew.read(new Headers({ cookie: `hyp_session=${value}` }))).data).toBeNull();

    let now = 1_700_000_000_000;
    const fixed = createSessionStore<{ uid: string }>({
      secret: SECRET,
      sliding: false,
      ttlSeconds: 100,
      now: () => now,
    });
    const v = (await fixed.write({ uid: 'x' })).split(';')[0]!.slice('hyp_session='.length);
    now += 90_000;
    expect((await fixed.read(new Headers({ cookie: `hyp_session=${v}` }))).needsRefresh).toBe(false);
  });

  it('binds the token to the cookie name and enforces the size guard', async () => {
    const a = createSessionStore<{ uid: string }>({ secret: SECRET, cookie: 'a' });
    const b = createSessionStore<{ uid: string }>({ secret: SECRET, cookie: 'b' });
    const value = (await a.write({ uid: 'u' })).split(';')[0]!.slice(2);
    expect((await b.read(new Headers({ cookie: `b=${value}` }))).data).toBeNull();
    await expect(a.write({ uid: 'x'.repeat(5000) })).rejects.toThrow(/4 KiB/);
    expect(() => createSessionStore({ secret: [] })).toThrow(/secret/);
  });
});
