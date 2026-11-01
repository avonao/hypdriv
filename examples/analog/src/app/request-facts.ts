import { isPlatformServer } from '@angular/common';
import { inject, makeStateKey, PLATFORM_ID, TransferState } from '@angular/core';
// Browser-safe entry: no Hypdriv runtime code in the client bundle.
import { injectHyp } from '@hypdriv/analog/angular';

export interface RequestFacts {
  requestId: string | null;
  runner: string | null;
  country: string | null;
  cspMode: string | null;
  newHero: boolean;
}

const FACTS = makeStateKey<RequestFacts>('hypdriv:request-facts');

/**
 * The facts of the request being rendered. The server reads them from Hypdriv (`injectHyp()`) and puts them into
 * Angular's transfer state; the browser reads them back, so hydration finds the markup it expects.
 */
export function injectRequestFacts(): RequestFacts | null {
  const state = inject(TransferState);
  if (!isPlatformServer(inject(PLATFORM_ID))) return state.get(FACTS, null);
  const hyp = injectHyp();
  if (!hyp) return null;
  const facts: RequestFacts = {
    requestId: hyp.requestId,
    runner: hyp.runner,
    country: hyp.country,
    cspMode: hyp.cspMode,
    newHero: hyp.flag('newHero', false),
  };
  state.set(FACTS, facts);
  return facts;
}
