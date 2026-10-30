import { base64Decode, base64Encode, HypDrivError, timingSafeEqual, utf8Encode } from '@hypdriv/core';

/** Current defaults; hashes below them report `needsRehash`. */
export const PASSWORD_DEFAULTS = {
  scrypt: { ln: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 },
  'pbkdf2-sha256': { iterations: 600_000, saltBytes: 16, keyBytes: 32 },
} as const;

export type PasswordAlgorithm = 'scrypt' | 'pbkdf2-sha256';

/** Options of `passwords.hash`. */
export interface PasswordHashOptions {
  /** Work factor: `ln` (log2 N) for scrypt, iterations for PBKDF2. */
  cost?: number;
  /** Force an algorithm (default: scrypt when `node:crypto` offers it, else PBKDF2-SHA256). */
  algorithm?: PasswordAlgorithm;
}

/** Parsed PHC string. */
export type ParsedPhc =
  | { algorithm: 'scrypt'; ln: number; r: number; p: number; salt: Uint8Array; hash: Uint8Array }
  | { algorithm: 'pbkdf2-sha256'; iterations: number; salt: Uint8Array; hash: Uint8Array };

type NodeScrypt = (
  password: Uint8Array,
  salt: Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
  callback: (err: Error | null, key: Uint8Array) => void,
) => void;

let nodeScryptPromise: Promise<NodeScrypt | null> | undefined;

/** Resolves Node's `scrypt` when the runtime exposes `node:crypto` (Node, Bun, workerd with `nodejs_compat`). */
export function loadNodeScrypt(): Promise<NodeScrypt | null> {
  if (nodeScryptPromise) return nodeScryptPromise;
  nodeScryptPromise = (async () => {
    try {
      const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
      const builtin = proc?.getBuiltinModule?.('node:crypto') as { scrypt?: NodeScrypt } | undefined;
      if (typeof builtin?.scrypt === 'function') return builtin.scrypt;
    } catch {
      // not Node
    }
    try {
      // Computed so bundlers neither inline nor trace it (Edge-runtime builds warn on literal `node:` imports).
      const specifier = ['node', 'crypto'].join(':');
      const mod = (await import(
        /* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ specifier
      )) as {
        scrypt?: NodeScrypt;
      };
      if (typeof mod.scrypt === 'function') return mod.scrypt;
    } catch {
      // no node:crypto in this runtime
    }
    return null;
  })();
  return nodeScryptPromise;
}

/** For tests: forget the cached `node:crypto` probe. */
export function __resetScryptDetection(): void {
  nodeScryptPromise = undefined;
}

function b64(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/=+$/, '');
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

async function pbkdf2(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', password as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    keyBytes * 8,
  );
  return new Uint8Array(bits);
}

// --- pure-JS scrypt (RFC 7914), used when node:crypto is unavailable ---------------------------

function R(a: number, b: number): number {
  return (a << b) | (a >>> (32 - b));
}

function salsa20_8(B: Uint32Array, offset: number): void {
  let x0 = B[offset]!,
    x1 = B[offset + 1]!,
    x2 = B[offset + 2]!,
    x3 = B[offset + 3]!;
  let x4 = B[offset + 4]!,
    x5 = B[offset + 5]!,
    x6 = B[offset + 6]!,
    x7 = B[offset + 7]!;
  let x8 = B[offset + 8]!,
    x9 = B[offset + 9]!,
    x10 = B[offset + 10]!,
    x11 = B[offset + 11]!;
  let x12 = B[offset + 12]!,
    x13 = B[offset + 13]!,
    x14 = B[offset + 14]!,
    x15 = B[offset + 15]!;
  for (let i = 0; i < 8; i += 2) {
    x4 ^= R(x0 + x12, 7);
    x8 ^= R(x4 + x0, 9);
    x12 ^= R(x8 + x4, 13);
    x0 ^= R(x12 + x8, 18);
    x9 ^= R(x5 + x1, 7);
    x13 ^= R(x9 + x5, 9);
    x1 ^= R(x13 + x9, 13);
    x5 ^= R(x1 + x13, 18);
    x14 ^= R(x10 + x6, 7);
    x2 ^= R(x14 + x10, 9);
    x6 ^= R(x2 + x14, 13);
    x10 ^= R(x6 + x2, 18);
    x3 ^= R(x15 + x11, 7);
    x7 ^= R(x3 + x15, 9);
    x11 ^= R(x7 + x3, 13);
    x15 ^= R(x11 + x7, 18);
    x1 ^= R(x0 + x3, 7);
    x2 ^= R(x1 + x0, 9);
    x3 ^= R(x2 + x1, 13);
    x0 ^= R(x3 + x2, 18);
    x6 ^= R(x5 + x4, 7);
    x7 ^= R(x6 + x5, 9);
    x4 ^= R(x7 + x6, 13);
    x5 ^= R(x4 + x7, 18);
    x11 ^= R(x10 + x9, 7);
    x8 ^= R(x11 + x10, 9);
    x9 ^= R(x8 + x11, 13);
    x10 ^= R(x9 + x8, 18);
    x12 ^= R(x15 + x14, 7);
    x13 ^= R(x12 + x15, 9);
    x14 ^= R(x13 + x12, 13);
    x15 ^= R(x14 + x13, 18);
  }
  B[offset] = (B[offset]! + x0) >>> 0;
  B[offset + 1] = (B[offset + 1]! + x1) >>> 0;
  B[offset + 2] = (B[offset + 2]! + x2) >>> 0;
  B[offset + 3] = (B[offset + 3]! + x3) >>> 0;
  B[offset + 4] = (B[offset + 4]! + x4) >>> 0;
  B[offset + 5] = (B[offset + 5]! + x5) >>> 0;
  B[offset + 6] = (B[offset + 6]! + x6) >>> 0;
  B[offset + 7] = (B[offset + 7]! + x7) >>> 0;
  B[offset + 8] = (B[offset + 8]! + x8) >>> 0;
  B[offset + 9] = (B[offset + 9]! + x9) >>> 0;
  B[offset + 10] = (B[offset + 10]! + x10) >>> 0;
  B[offset + 11] = (B[offset + 11]! + x11) >>> 0;
  B[offset + 12] = (B[offset + 12]! + x12) >>> 0;
  B[offset + 13] = (B[offset + 13]! + x13) >>> 0;
  B[offset + 14] = (B[offset + 14]! + x14) >>> 0;
  B[offset + 15] = (B[offset + 15]! + x15) >>> 0;
}

function blockMix(B: Uint32Array, Y: Uint32Array, r: number, X: Uint32Array): void {
  const words = 32 * r;
  X.set(B.subarray(words - 16, words));
  for (let i = 0; i < 2 * r; i++) {
    for (let k = 0; k < 16; k++) X[k] = (X[k]! ^ B[i * 16 + k]!) >>> 0;
    salsa20_8(X, 0);
    Y.set(X, i * 16);
  }
  for (let i = 0; i < r; i++) B.set(Y.subarray(i * 32, i * 32 + 16), i * 16);
  for (let i = 0; i < r; i++) B.set(Y.subarray(i * 32 + 16, i * 32 + 32), (r + i) * 16);
}

function roMix(B: Uint32Array, N: number, r: number): void {
  const words = 32 * r;
  const V = new Uint32Array(N * words);
  const Y = new Uint32Array(words);
  const X = new Uint32Array(16);
  for (let i = 0; i < N; i++) {
    V.set(B, i * words);
    blockMix(B, Y, r, X);
  }
  for (let i = 0; i < N; i++) {
    const j = B[words - 16]! % N;
    for (let k = 0; k < words; k++) B[k] = (B[k]! ^ V[j * words + k]!) >>> 0;
    blockMix(B, Y, r, X);
  }
}

/** Pure-JavaScript scrypt (RFC 7914). Slow but dependency-free; used when `node:crypto` is missing. */
export async function scryptJs(
  password: Uint8Array,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  keyBytes: number,
): Promise<Uint8Array> {
  if (N < 2 || (N & (N - 1)) !== 0) throw new RangeError('scrypt: N must be a power of two > 1');
  const blockBytes = 128 * r;
  const B = await pbkdf2(password, salt, 1, p * blockBytes);
  const view = new DataView(B.buffer, B.byteOffset, B.byteLength);
  const words = new Uint32Array(p * 32 * r);
  for (let i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, true);
  for (let i = 0; i < p; i++) roMix(words.subarray(i * 32 * r, (i + 1) * 32 * r), N, r);
  for (let i = 0; i < words.length; i++) view.setUint32(i * 4, words[i]!, true);
  return pbkdf2(password, B, 1, keyBytes);
}

async function scrypt(
  password: Uint8Array,
  salt: Uint8Array,
  ln: number,
  r: number,
  p: number,
  keyBytes: number,
): Promise<Uint8Array> {
  const N = 2 ** ln;
  const node = await loadNodeScrypt();
  if (node) {
    try {
      return await new Promise<Uint8Array>((resolve, reject) =>
        node(password, salt, keyBytes, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) =>
          err ? reject(err) : resolve(new Uint8Array(key)),
        ),
      );
    } catch {
      // fall through to the JS implementation (e.g. unsupported option in a compat layer)
    }
  }
  return scryptJs(password, salt, N, r, p, keyBytes);
}

/** Parses `$scrypt$ln=15,r=8,p=1$<salt>$<hash>` or `$pbkdf2-sha256$i=600000$<salt>$<hash>`. */
export function parsePhc(phc: string): ParsedPhc | null {
  const parts = phc.split('$');
  if (parts.length !== 5 || parts[0] !== '') return null;
  const [, algorithm, paramText, saltText, hashText] = parts as [string, string, string, string, string];
  const params: Record<string, number> = {};
  for (const kv of paramText.split(',')) {
    const [k, v] = kv.split('=');
    if (!k || v === undefined || !/^\d+$/.test(v)) return null;
    params[k] = Number(v);
  }
  let salt: Uint8Array;
  let hash: Uint8Array;
  try {
    salt = base64Decode(saltText);
    hash = base64Decode(hashText);
  } catch {
    return null;
  }
  if (!salt.length || !hash.length) return null;
  if (algorithm === 'scrypt') {
    if (params.ln === undefined || params.r === undefined || params.p === undefined) return null;
    return { algorithm, ln: params.ln, r: params.r, p: params.p, salt, hash };
  }
  if (algorithm === 'pbkdf2-sha256') {
    if (params.i === undefined) return null;
    return { algorithm, iterations: params.i, salt, hash };
  }
  return null;
}

/** Which scrypt implementation `hash`/`verify` will use. */
export async function detectPasswordBackend(): Promise<{
  scrypt: 'node' | 'js';
  default: PasswordAlgorithm;
}> {
  const node = await loadNodeScrypt();
  return { scrypt: node ? 'node' : 'js', default: node ? 'scrypt' : 'pbkdf2-sha256' };
}

/**
 * Hashes a password into a PHC string. scrypt (`ln=15,r=8,p=1`) when `node:crypto` is available,
 * otherwise PBKDF2-SHA256 with 600 000 iterations (OWASP 2023 guidance).
 */
export async function hash(password: string, options: PasswordHashOptions = {}): Promise<string> {
  if (typeof password !== 'string' || !password.length)
    throw new HypDrivError('E_VALIDATION', 'passwords.hash: password must be a non-empty string');
  const pw = utf8Encode(password.normalize('NFKC'));
  const algorithm = options.algorithm ?? (await detectPasswordBackend()).default;
  if (algorithm === 'scrypt') {
    const d = PASSWORD_DEFAULTS.scrypt;
    const ln = options.cost ?? d.ln;
    if (!Number.isInteger(ln) || ln < 4 || ln > 24)
      throw new HypDrivError(
        'E_VALIDATION',
        'passwords.hash: scrypt cost (ln) must be an integer between 4 and 24',
      );
    const salt = randomBytes(d.saltBytes);
    const key = await scrypt(pw, salt, ln, d.r, d.p, d.keyBytes);
    return `$scrypt$ln=${ln},r=${d.r},p=${d.p}$${b64(salt)}$${b64(key)}`;
  }
  const d = PASSWORD_DEFAULTS['pbkdf2-sha256'];
  const iterations = options.cost ?? d.iterations;
  if (!Number.isInteger(iterations) || iterations < 1)
    throw new HypDrivError('E_VALIDATION', 'passwords.hash: PBKDF2 cost must be a positive integer');
  const salt = randomBytes(d.saltBytes);
  const key = await pbkdf2(pw, salt, iterations, d.keyBytes);
  return `$pbkdf2-sha256$i=${iterations}$${b64(salt)}$${b64(key)}`;
}

/** Verifies a password against a PHC string produced by `hash` (either algorithm). Never throws. */
export async function verify(password: string, phc: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof phc !== 'string') return false;
  const parsed = parsePhc(phc);
  if (!parsed) return false;
  const pw = utf8Encode(password.normalize('NFKC'));
  try {
    const computed =
      parsed.algorithm === 'scrypt'
        ? await scrypt(pw, parsed.salt, parsed.ln, parsed.r, parsed.p, parsed.hash.length)
        : await pbkdf2(pw, parsed.salt, parsed.iterations, parsed.hash.length);
    return timingSafeEqual(computed, parsed.hash);
  } catch {
    return false;
  }
}

/** `true` when the hash uses parameters below the current defaults (or cannot be parsed). */
export function needsRehash(phc: string): boolean {
  const parsed = parsePhc(phc);
  if (!parsed) return true;
  if (parsed.algorithm === 'scrypt') {
    const d = PASSWORD_DEFAULTS.scrypt;
    return (
      parsed.ln < d.ln ||
      parsed.r < d.r ||
      parsed.p < d.p ||
      parsed.hash.length < d.keyBytes ||
      parsed.salt.length < d.saltBytes
    );
  }
  const d = PASSWORD_DEFAULTS['pbkdf2-sha256'];
  return (
    parsed.iterations < d.iterations || parsed.hash.length < d.keyBytes || parsed.salt.length < d.saltBytes
  );
}

/** Password hashing namespace (matches the `passwords` export in docs/contracts.md). */
export const passwords = { hash, verify, needsRehash, parsePhc, detectBackend: detectPasswordBackend };
