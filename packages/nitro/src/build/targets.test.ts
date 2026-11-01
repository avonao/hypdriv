import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { packageDir, runtimeFile } from './paths';
import {
  isDevPreset,
  isPrerenderPreset,
  isStaticPreset,
  supportsWorkerEntry,
  targetOfPreset,
} from './targets';

describe('Nitro presets', () => {
  it('maps presets to deployment targets', () => {
    expect(targetOfPreset('cloudflare-module')).toBe('cloudflare');
    expect(targetOfPreset('cloudflare_module')).toBe('cloudflare');
    expect(targetOfPreset('cloudflare-pages')).toBe('cloudflare');
    expect(targetOfPreset('vercel')).toBe('vercel');
    expect(targetOfPreset('vercel-edge')).toBe('vercel');
    expect(targetOfPreset('node-server')).toBe('node');
    expect(targetOfPreset(undefined)).toBe('node');
  });

  it('knows which presets take the Worker shell, are static, prerender or develop', () => {
    expect(supportsWorkerEntry('cloudflare-module')).toBe(true);
    expect(supportsWorkerEntry('cloudflare_module')).toBe(true);
    expect(supportsWorkerEntry('cloudflare-pages')).toBe(false);
    expect(isStaticPreset('static')).toBe(true);
    expect(isStaticPreset('cloudflare-pages-static')).toBe(true);
    expect(isStaticPreset('github-pages')).toBe(true);
    expect(isStaticPreset('node-server')).toBe(false);
    expect(isPrerenderPreset('nitro-prerender')).toBe(true);
    expect(isPrerenderPreset('node-server')).toBe(false);
    expect(isDevPreset('nitro-dev')).toBe(true);
    expect(isDevPreset('cloudflare-dev')).toBe(true);
    expect(isDevPreset('vercel')).toBe(false);
  });
});

describe('runtime file resolution', () => {
  it('finds the runtime plugins next to the sources', () => {
    for (const name of [
      'nitro2/plugin',
      'nitro3/plugin',
      'nitro2/cloudflare-worker',
      'nitro3/cloudflare-worker',
    ])
      expect(existsSync(runtimeFile(name))).toBe(true);
    expect(packageDir()).toMatch(/[\\/]src$/);
  });
});
