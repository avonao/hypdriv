import { hexEncode, utf8Encode } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import {
  detectPasswordBackend,
  hash,
  loadNodeScrypt,
  needsRehash,
  parsePhc,
  scryptJs,
  verify,
} from './passwords';

describe('passwords', () => {
  it('pure-JS scrypt matches RFC 7914 test vectors and Node', async () => {
    const v1 = await scryptJs(utf8Encode(''), utf8Encode(''), 16, 1, 1, 64);
    expect(hexEncode(v1)).toBe(
      '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906',
    );
    const v2 = await scryptJs(utf8Encode('password'), utf8Encode('NaCl'), 1024, 8, 16, 64);
    expect(hexEncode(v2)).toBe(
      'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
    );
    const node = await loadNodeScrypt();
    expect(node).not.toBeNull();
    const fromNode = await new Promise<Uint8Array>((resolve, reject) =>
      node!(
        utf8Encode('pw'),
        utf8Encode('salt'),
        32,
        { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (err, key) => (err ? reject(err) : resolve(new Uint8Array(key))),
      ),
    );
    expect(hexEncode(await scryptJs(utf8Encode('pw'), utf8Encode('salt'), 1024, 8, 1, 32))).toBe(
      hexEncode(fromNode),
    );
  });

  it('hashes with scrypt by default on Node and verifies both algorithms', async () => {
    expect(await detectPasswordBackend()).toEqual({ scrypt: 'node', default: 'scrypt' });
    const phc = await hash('correct horse battery staple', { cost: 10 });
    expect(phc).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await verify('correct horse battery staple', phc)).toBe(true);
    expect(await verify('correct horse battery stapl', phc)).toBe(false);
    expect(needsRehash(phc)).toBe(true); // ln=10 < 15
    const parsed = parsePhc(phc);
    expect(parsed?.algorithm).toBe('scrypt');

    const pbkdf2 = await hash('hunter22hunter', { algorithm: 'pbkdf2-sha256', cost: 1000 });
    expect(pbkdf2).toMatch(/^\$pbkdf2-sha256\$i=1000\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await verify('hunter22hunter', pbkdf2)).toBe(true);
    expect(await verify('hunter23hunter', pbkdf2)).toBe(false);
    expect(needsRehash(pbkdf2)).toBe(true); // 1000 < 600000
    expect(
      needsRehash(
        '$pbkdf2-sha256$i=600000$c2FsdHNhbHRzYWx0c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ),
    ).toBe(false);
    expect(
      needsRehash('$scrypt$ln=15,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=65536,t=3,p=4$abc$def')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('handles bad input without throwing from verify and normalises unicode', async () => {
    expect(await verify('x', 'not-a-phc')).toBe(false);
    expect(await verify('x', '$scrypt$ln=abc$a$b')).toBe(false);
    expect(parsePhc('$scrypt$ln=15,r=8,p=1$$')).toBeNull();
    await expect(hash('')).rejects.toThrow(/non-empty/);
    await expect(hash('x', { cost: 99 })).rejects.toThrow(/between 4 and 24/);
    const composed = await hash('café', { algorithm: 'pbkdf2-sha256', cost: 500 });
    expect(await verify('café', composed)).toBe(true);
  });
});
