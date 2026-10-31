import { flag, hyp } from '@hypdriv/tanstack-start/server';
import { createServerFn } from '@tanstack/react-start';

export interface RequestFacts {
  requestId: string | null;
  nonce: string | null;
  runner: string | null;
  country: string | null;
  newHero: boolean;
  renderedAt: string;
}

// Runs on the server: inside the SSR render (called in-process by the loader) and as an RPC on client
// navigations. `hyp()` reads the HypDriv context the request middleware (or the Worker shell) installed.
export const getRequestFacts = createServerFn({ method: 'GET' }).handler(async (): Promise<RequestFacts> => {
  const context = hyp();
  return {
    requestId: context?.requestId ?? null,
    nonce: context?.nonce ?? null,
    runner: context?.runner ?? null,
    country: context?.country ?? null,
    newHero: flag('newHero', false),
    renderedAt: new Date().toISOString(),
  };
});
