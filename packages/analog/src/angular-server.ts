import { injectRequest } from '@analogjs/router/tokens';
import {
  APP_BOOTSTRAP_LISTENER,
  type ComponentRef,
  CSP_NONCE,
  type EnvironmentProviders,
  makeEnvironmentProviders,
} from '@angular/core';
import { type HypRequestContext, hyp, nonce } from '@hypdriv/nitro/server';
import { HYP_CONTEXT } from './angular';

/**
 * `@hypdriv/analog/angular/server` — the server half of the Angular integration (it imports the Hypdriv runtime, so
 * keep it out of browser code: only `app.config.server.ts` uses it).
 */

/** The request header the pipeline hands the CSP nonce to the application in (`security.csp.nonceHeader`). */
const NONCE_HEADER = 'x-nonce';

function headerOf(
  request: { headers?: Record<string, string | string[] | undefined> } | null,
): string | null {
  const value = request?.headers?.[NONCE_HEADER];
  const first = Array.isArray(value) ? value[0] : value;
  return first || null;
}

/**
 * The CSP nonce of the request being rendered, or `null`: prerendered pages carry hashes (the build computes them),
 * and Nitro-cached renders must not carry one request's nonce. Call it in an injection context.
 */
export function injectNonce(): string | null {
  return nonce() ?? headerOf(injectRequest());
}

/**
 * Server providers for Hypdriv. Add them to the server application config (`app.config.server.ts`), not to the
 * browser's:
 *
 * ```ts
 * const serverConfig: ApplicationConfig = {
 *   providers: [provideServerRendering(), provideHypDriv()],
 * };
 * ```
 *
 * - `CSP_NONCE` becomes the request's nonce, so Angular stamps it on the styles and scripts it renders.
 * - The bootstrapped root element gets an `ngCspNonce` attribute with the nonce, which the browser side of Angular
 *   reads (`CSP_NONCE`'s default) for the styles it adds later, e.g. when a lazy page's component styles load.
 * - `HYP_CONTEXT` carries the request facts (`injectHyp()`).
 *
 * Outside Hypdriv's pipeline (`vite dev`, an unwrapped prerender) all of it is inert: no nonce, no context.
 */
export function provideHypDriv(): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: CSP_NONCE, useFactory: (): string | null => injectNonce() },
    { provide: HYP_CONTEXT, useFactory: (): HypRequestContext | null => hyp() ?? null },
    {
      provide: APP_BOOTSTRAP_LISTENER,
      multi: true,
      useFactory: () => {
        const requestNonce = injectNonce();
        return (root: ComponentRef<unknown>): void => {
          if (requestNonce) (root.location.nativeElement as Element).setAttribute('ngCspNonce', requestNonce);
        };
      },
    },
  ]);
}
