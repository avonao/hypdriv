import { REQUEST } from '@analogjs/router/tokens';
import {
  APP_BOOTSTRAP_LISTENER,
  CSP_NONCE,
  createEnvironmentInjector,
  type EnvironmentInjector,
  Injector,
  runInInjectionContext,
} from '@angular/core';
import { createContext, HEADER, loadConfig, runWithContext } from '@hypdriv/core';
import { ensureContextStore } from '@hypdriv/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import { HYP_CONTEXT, injectHyp } from './angular';
import { injectNonce, provideHypDriv } from './angular-server';

beforeAll(async () => {
  await ensureContextStore();
});

const pipeline = (nonce?: string) => {
  const ctx = createContext({
    request: new Request('https://example.com/ssr'),
    config: loadConfig({}),
    runner: 'host',
  });
  if (nonce) ctx.requestHeaders.set(HEADER.nonce, nonce);
  return ctx;
};

/** An Angular server application injector with `provideHypDriv()`, and an optional Analog `REQUEST`. */
function applicationInjector(request?: { headers: Record<string, string | string[] | undefined> }) {
  return createEnvironmentInjector(
    [provideHypDriv(), ...(request ? [{ provide: REQUEST, useValue: request }] : [])],
    Injector.NULL as EnvironmentInjector,
  );
}

describe('provideHypDriv', () => {
  it('provides the pipeline nonce as Angular’s CSP_NONCE while the request renders', async () => {
    const injector = applicationInjector();
    const nonce = await runWithContext(pipeline('nonce-from-pipeline'), () => injector.get(CSP_NONCE));
    expect(nonce).toBe('nonce-from-pipeline');
  });

  it('falls back to the x-nonce header the Nitro hook forwards onto the request', () => {
    const injector = applicationInjector({ headers: { 'x-nonce': 'nonce-from-header' } });
    // No pipeline context in this async flow (zone.js apps can lose it).
    expect(runInInjectionContext(injector, () => injectNonce())).toBe('nonce-from-header');
    expect(injector.get(CSP_NONCE)).toBe('nonce-from-header');
  });

  describe('the ngCspNonce attribute on the root element', () => {
    type Listener = (root: {
      location: { nativeElement: { setAttribute(name: string, value: string): void } };
    }) => void;
    const rootWith = () => {
      const attributes: Record<string, string> = {};
      return {
        attributes,
        root: {
          location: { nativeElement: { setAttribute: (n: string, v: string) => (attributes[n] = v) } },
        },
      };
    };

    it('carries the request’s nonce, for the styles the browser side of Angular adds later', () => {
      const injector = applicationInjector();
      const { attributes, root } = rootWith();
      runWithContext(pipeline('root-nonce'), () => {
        for (const listener of injector.get(APP_BOOTSTRAP_LISTENER) as Listener[]) listener(root);
      });
      expect(attributes).toEqual({ ngCspNonce: 'root-nonce' });
    });

    it('is not written without a nonce (prerender, vite dev)', () => {
      const injector = applicationInjector();
      const { attributes, root } = rootWith();
      for (const listener of injector.get(APP_BOOTSTRAP_LISTENER) as Listener[]) listener(root);
      expect(attributes).toEqual({});
    });
  });

  it('prefers the pipeline context over the header', () => {
    const injector = applicationInjector({ headers: { 'x-nonce': 'stale' } });
    const nonce = runWithContext(pipeline('fresh'), () =>
      runInInjectionContext(injector, () => injectNonce()),
    );
    expect(nonce).toBe('fresh');
  });

  it('reads the first value of a repeated header', () => {
    const injector = applicationInjector({ headers: { 'x-nonce': ['first', 'second'] } });
    expect(runInInjectionContext(injector, () => injectNonce())).toBe('first');
  });

  it('is inert without a pipeline and without a request (vite dev, build-time prerender)', () => {
    const injector = applicationInjector();
    expect(runInInjectionContext(injector, () => injectNonce())).toBeNull();
    expect(injector.get(CSP_NONCE)).toBeNull();
    expect(injector.get(HYP_CONTEXT)).toBeNull();
    expect(runInInjectionContext(injector, () => injectHyp())).toBeNull();
  });

  it('exposes the request facts through injectHyp()', () => {
    const ctx = pipeline('n');
    const injector = applicationInjector();
    const facts = runWithContext(ctx, () => runInInjectionContext(injector, () => injectHyp()));
    expect(facts?.requestId).toBe(ctx.id);
    expect(facts?.runner).toBe('host');
    expect(facts?.nonce).toBe('n');
  });
});

describe('injectHyp', () => {
  it('is null where the provider is not installed (the browser application config)', () => {
    const injector = createEnvironmentInjector([], Injector.NULL as EnvironmentInjector);
    expect(runInInjectionContext(injector, () => injectHyp())).toBeNull();
  });
});
