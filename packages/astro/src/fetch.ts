/// <reference path="../virtual.d.ts" />

import { prerendering } from 'virtual:hypdriv/astro';
import { FetchState } from 'astro/fetch';
import { platformInput } from './hook';
import { handler } from './runtime';

/** The default export of `src/fetch.ts` (Astro's `Fetchable`). */
export interface AstroFetchable {
  fetch(request: Request): Promise<Response>;
}

/**
 * `@hypdriv/astro/fetch` — runs the Hypdriv Drivetrain around Astro's whole request pipeline from `src/fetch.ts`
 * (Astro 7 advanced routing). The middleware the integration registers covers every route Astro renders; wrapping the
 * fetch entry also covers what Astro answers before middleware: unmatched URLs served by a prerendered 404 page,
 * `redirects` from the Astro config, trailing-slash normalisation and invalid-encoding responses. The middleware
 * passes through inside it, so the pipeline runs once per request.
 *
 * ```ts
 * // src/fetch.ts
 * import { astro } from 'astro/fetch';
 * import { withHypDriv } from '@hypdriv/astro/fetch';
 * export default withHypDriv((state) => astro(state));
 * ```
 */
export function withHypDriv(handle: (state: FetchState) => Promise<Response> | Response): AstroFetchable {
  return {
    async fetch(request) {
      const state = new FetchState(request);
      // Cloudflare prerenders through this entry: the build-time bundle passes every request through.
      if (prerendering) return handle(state);
      const input = platformInput({
        request,
        isPrerendered: false,
        locals: state.locals,
        get clientAddress() {
          const address = state.clientAddress;
          if (!address) throw new Error('no client address');
          return address;
        },
      });
      return handler(request, { ...input, upstream: async () => handle(state) });
    },
  };
}
