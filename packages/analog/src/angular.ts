import { injectRequest } from '@analogjs/router/tokens';
import {
  CSP_NONCE,
  type EnvironmentProviders,
  InjectionToken,
  inject,
  makeEnvironmentProviders,
} from '@angular/core';
import { FACTS_KEY, type HypEventContext, type HypRequestContext, hyp, nonce } from '@hypdriv/nitro/server';

/**
 * The Hypdriv request context of the render in progress: request id, country, locale, edge flags, runner. `null` in
 * the browser, while Angular prerenders without the pipeline, and when the render is not a request.
 */
export const HYP_CONTEXT = new InjectionToken<HypRequestContext | null>('@hypdriv/analog request context');

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
 * - `CSP_NONCE` becomes the request's nonce, so Angular stamps it on the styles and scripts it renders (and writes
 *   `ngCspNonce` on the root element, which the browser side of Angular reads for the styles it adds later).
 * - `HYP_CONTEXT` carries the request facts (`injectHyp()`).
 *
 * Outside Hypdriv's pipeline (`vite dev`, an unwrapped prerender) both are inert: no nonce, no context.
 */
export function provideHypDriv(): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: CSP_NONCE, useFactory: (): string | null => injectNonce() },
    { provide: HYP_CONTEXT, useFactory: (): HypRequestContext | null => hyp() ?? null },
  ]);
}

/** The request context (`hyp()`) inside a component, service or guard rendering on the server; `null` elsewhere. */
export function injectHyp(): HypRequestContext | null {
  return inject(HYP_CONTEXT, { optional: true }) ?? null;
}

export { FACTS_KEY, type HypEventContext, type HypRequestContext };
