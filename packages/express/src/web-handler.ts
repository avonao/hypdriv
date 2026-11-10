import type { IncomingMessage, ServerResponse } from 'node:http';
import { bridgeRequest, writeWebResponse } from '@hypdriv/runtime/node';

export interface WebHandlerOptions {
  /** Trust `x-forwarded-proto` / `x-forwarded-host` for the request URL. */
  trustProxy?: boolean;
  /** The public origin of the site, when the `Host` header cannot be trusted. */
  origin?: string;
}

/**
 * Mounts a Web-standard handler (`(request: Request) => Response`) as an Express route handler:
 * `jobHandler()` of Hypdriv, `toNodeHandler`-less libraries such as Better Auth's `auth.handler`, anything written
 * for `fetch`. The request body streams from the Node request when the handler reads it and the response streams
 * back without being buffered.
 *
 * ```ts
 * app.post('/api/jobs', webHandler(jobHandler({ handlers: { … } })));
 * ```
 */
export function webHandler(
  handler: (request: Request) => Response | Promise<Response>,
  options: WebHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => Promise<void> {
  return async (req, res, next) => {
    try {
      const { request, abort } = bridgeRequest(req, options);
      res.once('close', () => {
        if (!res.writableFinished) abort(new Error('client disconnected'));
      });
      const response = await handler(request);
      await writeWebResponse(res, response, { method: request.method });
    } catch (error) {
      if (res.headersSent) res.destroy(error instanceof Error ? error : new Error(String(error)));
      else next(error);
    }
  };
}
