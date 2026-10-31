import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HypHandler } from '@hypdriv/runtime';
import { sendWebResponse, toWebRequest } from './node/index';

type Next = (err?: unknown) => void;

/**
 * Connect middleware that runs a Hypdriv handler in Vite's dev or preview server. `render` produces the
 * application's response for requests the pipeline should wrap (HTML documents, `/_hypdriv/*`); returning `null`
 * hands the request back to Vite untouched (modules, assets, HMR).
 */
export function connectMiddleware(input: {
  handler: HypHandler;
  render: (request: Request) => Promise<Response | null>;
  /** Whether to run the pipeline for the request at all (default: everything except Vite internals). */
  wants?: (url: URL, request: Request) => boolean;
}): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  return (req, res, next) => {
    void (async () => {
      try {
        const request = toWebRequest(req);
        const url = new URL(request.url);
        if (input.wants && !input.wants(url, request) && !url.pathname.startsWith('/_hypdriv/'))
          return next();
        let passed = false;
        const response = await input.handler(request, {
          ip: req.socket.remoteAddress ?? '127.0.0.1',
          upstream: async (forwarded) => {
            const rendered = await input.render(forwarded);
            if (rendered) return rendered;
            passed = true;
            return new Response(null, { status: 204, headers: { 'x-hypdriv-pass': '1' } });
          },
        });
        if (passed || response.headers.get('x-hypdriv-pass') === '1') {
          // The application did not answer: keep the pipeline's headers and let Vite serve the request.
          response.headers.forEach((value, name) => {
            if (name !== 'x-hypdriv-pass' && name !== 'content-length' && name !== 'content-type')
              res.setHeader(name, value);
          });
          return next();
        }
        await sendWebResponse(res, response, request.method);
      } catch (err) {
        next(err);
      }
    })();
  };
}

/** Vite-internal request paths the dev pipeline never wraps. */
export function isViteInternal(pathname: string): boolean {
  return (
    pathname.startsWith('/@') ||
    pathname.startsWith('/__vite') ||
    pathname.startsWith('/node_modules/') ||
    pathname.includes('?') ||
    /\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|sass|less|map|json|wasm)$/.test(pathname)
  );
}
