import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatFindings, isCandidateEnvValue, scanSecrets } from './index';

// assembled at run time so the fixture never appears as a literal in the source
const STRIPE_LIKE = ['sk', 'live', '51Hx9AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('_');

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hypdriv-scan-'));
  await mkdir(join(dir, 'assets', 'chunks'), { recursive: true });
  await mkdir(join(dir, 'assets', 'node_modules'), { recursive: true });
  await writeFile(
    join(dir, 'assets', 'chunks', 'app.js'),
    [
      'const a = "nothing to see";',
      `const stripe = "${STRIPE_LIKE}";`,
      'fetch(url, { headers: { Authorization: "Bearer " + "super-secret-database-password-42" } });',
      'const pub = "public-value-that-is-allowed";',
    ].join('\n'),
  );
  await writeFile(join(dir, 'assets', 'chunks', 'app.js.map'), '{"mappings":"AKIAIOSFODNN7EXAMPLE"}');
  await writeFile(
    join(dir, 'assets', 'styles.css'),
    'body{--x:"ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD"}',
  );
  await writeFile(
    join(dir, 'assets', 'image.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x73, 0x6b, 0x5f]),
  );
  await writeFile(join(dir, 'assets', 'notes.md'), STRIPE_LIKE);
  await writeFile(join(dir, 'assets', 'node_modules', 'dep.js'), STRIPE_LIKE);
  await symlink(join(dir, 'assets', 'chunks', 'app.js'), join(dir, 'assets', 'link.js'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('scanSecrets', () => {
  it('finds pattern and env matches with positions and redacted snippets', async () => {
    const findings = await scanSecrets({
      dirs: ['assets'],
      cwd: dir,
      env: {
        DATABASE_PASSWORD: 'super-secret-database-password-42',
        NEXT_PUBLIC_API: 'public-value-that-is-allowed',
        ALLOWED_THING: 'public-value-that-is-allowed',
        SHORT: 'abc',
        PATH: '/usr/bin:/bin',
        HOME_URL: 'https://example.com/account/settings',
        NODE_VERSION: '22.12.0',
      },
      envAllowlist: ['ALLOWED_THING'],
    });
    expect(findings.map((f) => [f.id, f.file.replace(/\\/g, '/'), f.line, f.column, f.snippet])).toEqual([
      ['stripe-secret', 'assets/chunks/app.js', 2, 17, 'sk_l***'],
      ['env:DATABASE_PASSWORD', 'assets/chunks/app.js', 3, 53, 'supe***'],
      ['aws-access-key', 'assets/chunks/app.js.map', 1, 14, 'AKIA***'],
      ['github-token', 'assets/styles.css', 1, 11, 'ghp_***'],
    ]);
    expect(findings[1]).toMatchObject({ kind: 'env', envName: 'DATABASE_PASSWORD', severity: 'error' });
    expect(findings[0]).toMatchObject({ kind: 'pattern', severity: 'error' });
  });

  it('honours ignore, extensions and size limits', async () => {
    const ignored = await scanSecrets({
      dirs: [join(dir, 'assets')],
      cwd: dir,
      env: {},
      ignore: ['stripe-secret', 'github-token'],
    });
    expect(ignored.map((f) => f.id)).toEqual(['aws-access-key']);
    const md = await scanSecrets({ dirs: [join(dir, 'assets')], cwd: dir, env: {}, extensions: ['md'] });
    expect(md.map((f) => f.file.replace(/\\/g, '/'))).toEqual(['assets/notes.md']);
    const tiny = await scanSecrets({ dirs: [join(dir, 'assets')], cwd: dir, env: {}, maxFileBytes: 10 });
    expect(tiny).toEqual([]);
    const missing = await scanSecrets({ dirs: [join(dir, 'does-not-exist')], cwd: dir, env: {} });
    expect(missing).toEqual([]);
  });

  it('classifies env candidates', () => {
    const o = { publicPrefixes: ['NEXT_PUBLIC_'], allowlist: new Set(['OK']), minLength: 12 };
    expect(isCandidateEnvValue('DB_PASSWORD', 'p4ssw0rd-with-length', o)).toBe(true);
    expect(isCandidateEnvValue('NEXT_PUBLIC_X', 'p4ssw0rd-with-length', o)).toBe(false);
    expect(isCandidateEnvValue('OK', 'p4ssw0rd-with-length', o)).toBe(false);
    expect(isCandidateEnvValue('X', '/usr/local/bin', o)).toBe(false);
    expect(isCandidateEnvValue('X', 'https://api.example.com/v1/items', o)).toBe(false);
    expect(isCandidateEnvValue('X', 'postgres://user:pw@db.internal/app', o)).toBe(true);
    expect(isCandidateEnvValue('X', '123456789012345', o)).toBe(false);
    expect(isCandidateEnvValue('X', 'production-environment', o)).toBe(false);
    expect(isCandidateEnvValue('X', undefined, o)).toBe(false);
    // The deployment id is public by design (it is in every `?dpl=` asset URL): never a leak.
    expect(isCandidateEnvValue('NEXT_DEPLOYMENT_ID', 'build-TfctsWXpff2fKS-9f3a1c', o)).toBe(false);
    expect(isCandidateEnvValue('__HYPDRIV_BUILD_DEPLOYMENT_ID', 'build-TfctsWXpff2fKS-9f3a1c', o)).toBe(
      false,
    );
  });

  it('formats findings', async () => {
    expect(formatFindings([])).toBe('No secrets found.');
    const text = formatFindings([
      {
        id: 'stripe-secret',
        severity: 'error',
        kind: 'pattern',
        file: 'a.js',
        line: 2,
        column: 17,
        snippet: 'sk_l***',
      },
      {
        id: 'env:DB',
        severity: 'error',
        kind: 'env',
        envName: 'DB',
        file: 'a.js',
        line: 3,
        column: 4,
        snippet: 'supe***',
      },
      { id: 'jwt', severity: 'warn', kind: 'pattern', file: 'b.js', line: 1, column: 1, snippet: 'eyJh***' },
    ]);
    expect(text).toContain('error  a.js:2:17  stripe-secret  sk_l***');
    expect(text).toContain('env value of DB');
    expect(text).toContain('3 findings (2 errors, 1 warning)');
  });
});
