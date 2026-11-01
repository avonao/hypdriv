import { flag, hyp } from '@hypdriv/solid-start/server';
import { query } from '@solidjs/router';

export interface RequestFacts {
  requestId: string | null;
  nonce: string | null;
  runner: string | null;
  country: string | null;
  newHero: boolean;
  renderedAt: string;
}

// Runs on the server: in-process during server rendering and as an RPC (`/_server`) on client navigations.
// `hyp()` reads the Hypdriv context the pipeline (Nitro plugin or Worker shell) installed for the request.
export const getRequestFacts = query(async (): Promise<RequestFacts> => {
  'use server';
  const context = hyp();
  return {
    requestId: context?.requestId ?? null,
    nonce: context?.nonce ?? null,
    runner: context?.runner ?? null,
    country: context?.country ?? null,
    newHero: flag('newHero', false),
    renderedAt: new Date().toISOString(),
  };
}, 'request-facts');
