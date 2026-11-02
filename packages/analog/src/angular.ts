import { InjectionToken, inject } from '@angular/core';
import type { HypRequestContext } from '@hypdriv/nitro/server';

/**
 * `@hypdriv/analog/angular` — what components and services share with the browser bundle. It imports nothing from
 * the Hypdriv runtime, so it is safe in client code; the server config uses `provideHypDriv()` from
 * `@hypdriv/analog/angular/server`.
 */

/**
 * The Hypdriv request context of the render in progress: request id, country, locale, edge flags, runner. `null` in
 * the browser, while Angular prerenders without the pipeline, and when the render is not a request.
 */
export const HYP_CONTEXT = new InjectionToken<HypRequestContext | null>('@hypdriv/analog request context');

/**
 * The request context (`hyp()`) inside a component, service or guard rendering on the server; `null` elsewhere. In the
 * browser the application's state does not carry it: hand what the page needs over with `TransferState`.
 */
export function injectHyp(): HypRequestContext | null {
  return inject(HYP_CONTEXT, { optional: true }) ?? null;
}

export type { HypRequestContext };
