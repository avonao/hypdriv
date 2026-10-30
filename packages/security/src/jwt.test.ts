import { base64Encode, base64UrlEncode, utf8Encode } from '@hypdriv/core';
import { describe, expect, it, vi } from 'vitest';
import { clearJwksCache, decode, type Jwk, JwtError, sign, verify } from './jwt';

const HS_SECRET = 'hs256-shared-secret-with-at-least-32-characters';

async function pem(key: CryptoKey): Promise<string> {
  const format = key.type === 'private' ? 'pkcs8' : 'spki';
  const label = key.type === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY';
  const der = base64Encode(new Uint8Array(await crypto.subtle.exportKey(format, key)));
  return `-----BEGIN ${label}-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----`;
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    if (error instanceof JwtError) return error.reason;
    throw error;
  }
}

describe('jwt', () => {
  it('HS256 sign + verify with claims', async () => {
    const now = 1_700_000_000_000;
    const token = await sign({ sub: 'u1', role: 'admin' }, HS_SECRET, {
      alg: 'HS256',
      expiresIn: 60,
      issuer: 'hypdriv',
      audience: ['web', 'api'],
      now,
    });
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(decode(token)).toMatchObject({
      header: { alg: 'HS256', typ: 'JWT' },
      payload: { sub: 'u1', iat: 1_700_000_000, exp: 1_700_000_060, iss: 'hypdriv', aud: ['web', 'api'] },
    });
    const { payload } = await verify(token, HS_SECRET, { issuer: 'hypdriv', audience: 'api', now });
    expect(payload.role).toBe('admin');
    expect(await reason(verify(token, HS_SECRET, { now: now + 61_000 }))).toBe('expired');
    expect(await reason(verify(token, HS_SECRET, { now: now + 61_000, clockTolerance: 5 }))).toBe('ok');
    expect(await reason(verify(token, HS_SECRET, { now, issuer: 'other' }))).toBe('issuer');
    expect(await reason(verify(token, HS_SECRET, { now, audience: 'mobile' }))).toBe('audience');
    expect(await reason(verify(token, HS_SECRET, { now, subject: 'u2' }))).toBe('subject');
    expect(await reason(verify(token, HS_SECRET, { now: now - 10_000 }))).toBe('issued-in-future');
    expect(await reason(verify(token, HS_SECRET, { now: now + 30_000, maxTokenAge: 10 }))).toBe('too-old');
    expect(await reason(verify(token, 'another-secret-that-is-long-enough-xxxxxx', { now }))).toBe(
      'invalid-signature',
    );
    expect(await reason(verify(`${parts[0]}.${parts[1]}.AAAA`, HS_SECRET, { now }))).toBe(
      'invalid-signature',
    );
    expect(await reason(verify('garbage', HS_SECRET))).toBe('malformed');
    await expect(sign({}, 'short', { alg: 'HS256' })).rejects.toThrow(/32 characters/);
  });

  it('rejects alg none, disallowed algorithms and key confusion', async () => {
    const header = base64UrlEncode(utf8Encode(JSON.stringify({ alg: 'none', typ: 'JWT' })));
    const payload = base64UrlEncode(utf8Encode(JSON.stringify({ sub: 'x' })));
    expect(await reason(verify(`${header}.${payload}.`, HS_SECRET))).toBe('alg-none');
    const hs = await sign({ sub: 'x' }, HS_SECRET, { alg: 'HS256' });
    expect(await reason(verify(hs, HS_SECRET, { algorithms: ['RS256'] }))).toBe('alg-not-allowed');
    const { publicKey } = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    // An HS256 token signed with the public PEM as the "secret" must never verify against that PEM.
    const publicPem = await pem(publicKey);
    const confused = await sign({ sub: 'x' }, publicPem.replace(/-----[^-]+-----|\s/g, ''), { alg: 'HS256' });
    expect(await reason(verify(confused, publicPem))).toBe('key-mismatch');
    expect(await reason(verify(confused, publicKey))).toBe('key-mismatch');
  });

  it('ES256 with CryptoKey and PEM (raw r||s signatures)', async () => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const token = await sign({ sub: 'es' }, privateKey, { alg: 'ES256', kid: 'k1' });
    const sig = token.split('.')[2]!;
    expect(sig.length).toBe(86); // 64 bytes base64url
    expect(decode(token)?.header.kid).toBe('k1');
    expect((await verify(token, publicKey)).payload.sub).toBe('es');
    expect((await verify(token, await pem(publicKey))).payload.sub).toBe('es');
    const fromPem = await sign({ sub: 'pem' }, await pem(privateKey), { alg: 'ES256' });
    expect((await verify(fromPem, publicKey)).payload.sub).toBe('pem');
    expect(await reason(verify(token, privateKey.algorithm.name === 'ECDSA' ? HS_SECRET : HS_SECRET))).toBe(
      'key-mismatch',
    );
    const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as Jwk;
    expect((await verify(token, [{ ...jwk, kid: 'k1' }])).payload.sub).toBe('es');
    expect(await reason(verify(token, [{ ...jwk, kid: 'other' }]))).toBe('unknown-kid');
  });

  it('RS256 with PEM keys and JWKS fetching (cache + refetch on unknown kid)', async () => {
    clearJwksCache();
    const a = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const b = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const tokenA = await sign({ sub: 'a' }, await pem(a.privateKey), { alg: 'RS256', kid: 'a' });
    const tokenB = await sign({ sub: 'b' }, b.privateKey, { alg: 'RS256', kid: 'b' });
    expect((await verify(tokenA, await pem(a.publicKey))).payload.sub).toBe('a');
    expect(await reason(verify(tokenA, await pem(b.publicKey)))).toBe('invalid-signature');

    const jwkA = { ...((await crypto.subtle.exportKey('jwk', a.publicKey)) as Jwk), kid: 'a', use: 'sig' };
    const jwkB = { ...((await crypto.subtle.exportKey('jwk', b.publicKey)) as Jwk), kid: 'b', use: 'sig' };
    let keys = [jwkA];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } }),
    );
    const jwks = { jwksUrl: 'https://issuer.test/.well-known/jwks.json' };
    expect((await verify(tokenA, jwks, { fetch: fetchMock as unknown as typeof fetch })).payload.sub).toBe(
      'a',
    );
    expect((await verify(tokenA, jwks, { fetch: fetchMock as unknown as typeof fetch })).payload.sub).toBe(
      'a',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
    keys = [jwkA, jwkB];
    expect((await verify(tokenB, jwks, { fetch: fetchMock as unknown as typeof fetch })).payload.sub).toBe(
      'b',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2); // refetched once for the unknown kid
    const broken = vi.fn(async () => new Response('nope', { status: 500 }));
    expect(
      await reason(
        verify(tokenA, { jwksUrl: 'https://down.test/jwks' }, { fetch: broken as unknown as typeof fetch }),
      ),
    ).toBe('jwks-fetch-failed');
  });

  it('explains unsupported PEM formats', async () => {
    await expect(
      verify('a.b.c', '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----'),
    ).rejects.toThrow(/malformed|PKCS#8/i);
    const hs = await sign({ sub: 'x' }, HS_SECRET, { alg: 'HS256' });
    await expect(
      verify(
        hs.replace(/^[^.]+/, base64UrlEncode(utf8Encode(JSON.stringify({ alg: 'RS256' })))),
        '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----',
      ),
    ).rejects.toThrow(/PKCS#8/);
  });
});
