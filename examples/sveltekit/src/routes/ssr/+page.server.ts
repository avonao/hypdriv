import { flag, hyp, nonce } from '@hypdriv/sveltekit/server';

// Rendered per request inside Hypdriv's handle: `hyp()` is the request's Hypdriv context.
export const load = () => {
  const context = hyp();
  const requestNonce = nonce() ?? null;
  return {
    requestId: context?.requestId ?? null,
    runner: context?.runner ?? null,
    route: context?.route ?? null,
    country: context?.country ?? null,
    cspMode: context?.cspMode ?? null,
    nonce: requestNonce,
    newHero: flag('newHero', false),
    // A third-party style inline script: it needs the request's nonce to run under Hypdriv's policy.
    inlineScript: requestNonce
      ? `<script nonce="${requestNonce}">document.documentElement.dataset.hypdriv = 'ok';</script>`
      : '',
    // Streamed after the shell: SvelteKit writes it in a later <script> chunk, which carries the same nonce.
    streamed: new Promise<string>((resolve) => setTimeout(() => resolve('streamed after the shell'), 25)),
  };
};
