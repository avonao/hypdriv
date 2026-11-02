import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, tempProject } from '../../__tests__/helpers';
import { nitroCloudflareVerdict, tsconfigNoEmit } from './nitro';

afterEach(cleanupProjects);

describe('nitroCloudflareVerdict', () => {
  it('accepts cloudflare-module (either spelling) with deployConfig', () => {
    expect(nitroCloudflareVerdict(["preset: 'cloudflare-module', cloudflare: { deployConfig: true }"])).toBe(
      'ok',
    );
    expect(
      nitroCloudflareVerdict([
        "preset: 'cloudflare_module'",
        'cloudflare: { deployConfig: true, nodeCompat: true }',
      ]),
    ).toBe('ok');
    // A preset table keyed by target still selects the module.
    expect(
      nitroCloudflareVerdict([
        "const presets = { cloudflare: 'cloudflare-module', vercel: 'vercel' };",
        'cloudflare: { deployConfig: true }',
      ]),
    ).toBe('ok');
  });

  it('notes a cloudflare-module build without deployConfig', () => {
    expect(nitroCloudflareVerdict(["preset: 'cloudflare-module'"])).toBe('no-deploy-config');
    expect(nitroCloudflareVerdict(["preset: 'cloudflare-module', cloudflare: { deployConfig: false }"])).toBe(
      'no-deploy-config',
    );
  });

  it('flags cloudflare-pages and a missing preset', () => {
    expect(nitroCloudflareVerdict(["preset: 'cloudflare-pages'"])).toBe('pages');
    expect(nitroCloudflareVerdict(["preset: 'node-server'"])).toBe('missing');
    expect(nitroCloudflareVerdict([])).toBe('missing');
  });
});

describe('tsconfigNoEmit', () => {
  it('reads the nearest definition along the extends chain', () => {
    const p = tempProject({
      'tsconfig.json': '{\n  // base\n  "compilerOptions": { "noEmit": true, "strict": true }\n}\n',
      'tsconfig.app.json': '{ "extends": "./tsconfig.json", "files": ["src/main.ts"] }',
      'tsconfig.emit.json': '{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": false } }',
      'tsconfig.plain.json': '{ "compilerOptions": { "strict": true } }',
    });
    expect(tsconfigNoEmit(`${p.dir}/tsconfig.app.json`)).toBe(true);
    expect(tsconfigNoEmit(`${p.dir}/tsconfig.emit.json`)).toBe(false);
    expect(tsconfigNoEmit(`${p.dir}/tsconfig.plain.json`)).toBeNull();
    expect(tsconfigNoEmit(`${p.dir}/missing.json`)).toBeNull();
  });

  it('ignores package extends and survives invalid JSON', () => {
    const p = tempProject({
      'tsconfig.app.json': '{ "extends": "@tsconfig/node22/tsconfig.json" }',
      'broken.json': '{ nope',
    });
    expect(tsconfigNoEmit(`${p.dir}/tsconfig.app.json`)).toBeNull();
    expect(tsconfigNoEmit(`${p.dir}/broken.json`)).toBeNull();
  });
});
