import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetViteState, viteState } from './state';

afterEach(() => resetViteState());

describe('viteState', () => {
  it('is one process-wide slot, shared by every copy of the module', async () => {
    viteState().root = '/work/app';
    // Vite bundles vite.config.ts separately: a second evaluation of the module still sees the same slot.
    vi.resetModules();
    const copy = await import('./state');
    expect(copy.viteState()).toBe(viteState());
    expect(copy.viteState().root).toBe('/work/app');
  });

  it('is cleared by resetViteState', () => {
    Object.assign(viteState(), { root: '/a', base: '/b/', manifest: true });
    resetViteState();
    expect(viteState()).toEqual({});
  });
});
