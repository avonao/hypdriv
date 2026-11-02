import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { normalizeIp } from '@hypdriv/core';
import { ResponseCapture } from './capture';

/** What `expressFetch` calls: an Express application (or any `(req, res)` / `(req, res, next)` handler). */
export type ExpressHandler = (req: never, res: never, next?: never) => unknown;

/** The synthetic requests of `expressFetch`: the Drivetrain middleware lets them straight through. */
const DETACHED = new WeakSet<IncomingMessage>();

/** Whether a request was created by `expressFetch` (the middleware must not run the pipeline for it again). */
export function isDetached(req: IncomingMessage): boolean {
  return DETACHED.has(req);
}

export interface ExpressFetchOptions {
  /** The peer address the synthetic request reports (`req.socket.remoteAddress`, `req.ip`). Default `127.0.0.1`. */
  ip?: string;
}

/** An Express application (it has `listen()`) as opposed to a router (which needs a `next` callback). */
function isApplication(app: unknown): app is { handle: unknown } {
  const candidate = app as { handle?: unknown; listen?: unknown };
  return (
    typeof app === 'function' &&
    typeof candidate.handle === 'function' &&
    typeof candidate.listen === 'function'
  );
}

/**
 * Runs a Web `Request` through an Express application — with its whole middleware stack, routers and error
 * handlers — and returns the application's response as a Web `Response`, without a socket or a listening server.
 * The response streams (`res.write()` feeds the body as it is called). Used for the background re-rendering of
 * stale-while-revalidate, and handy for tests and for serving an Express app from a `fetch`-shaped host.
 *
 * The synthetic request is marked: `hypdriv()` in the app's stack passes it through instead of running the
 * pipeline again.
 */
export function expressFetch(
  app: ExpressHandler,
  request: Request,
  options: ExpressFetchOptions = {},
): Promise<Response> {
  const socket = new Socket();
  const address = normalizeIp(options.ip ?? '127.0.0.1');
  Object.defineProperty(socket, 'remoteAddress', { value: address, configurable: true });
  Object.defineProperty(socket, 'remoteFamily', {
    value: address.includes(':') ? 'IPv6' : 'IPv4',
    configurable: true,
  });
  const req = new IncomingMessage(socket);
  const url = new URL(request.url);
  req.method = request.method;
  req.url = `${url.pathname}${url.search}`;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  const rawHeaders: string[] = [];
  const headers: Record<string, string | string[]> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
    rawHeaders.push(name, value);
  });
  if (!headers.host) {
    headers.host = url.host;
    rawHeaders.push('host', url.host);
  }
  // A Web `Request` leaves the framing of its body to the transport; body parsers (`type-is`) look for it.
  if (request.body && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
    headers['transfer-encoding'] = 'chunked';
    rawHeaders.push('transfer-encoding', 'chunked');
  }
  req.headers = headers;
  req.rawHeaders = rawHeaders;
  if (request.body) {
    const reader = request.body.getReader();
    // `IncomingMessage` leaves "read more" switched off (its HTTP parser pushes), so a pull-only `_read` stalls after
    // the first chunk: keep pulling while the stream wants data, and again whenever it asks.
    let pulling = false;
    const pump = () => {
      if (pulling) return;
      pulling = true;
      reader.read().then(
        ({ done, value }) => {
          pulling = false;
          if (done) {
            req.complete = true;
            req.push(null);
          } else if (req.push(value)) pump();
        },
        (error) => req.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    };
    req._read = pump;
  } else {
    req.complete = true;
    req.push(null);
  }
  DETACHED.add(req);
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  const capture = new ResponseCapture(req, res);
  try {
    const run = app as unknown as (
      req: IncomingMessage,
      res: ServerResponse,
      next?: (error?: unknown) => void,
    ) => unknown;
    if (isApplication(app)) void Promise.resolve(run(req, res)).catch((error) => capture.fail(error));
    else
      void Promise.resolve(
        run(req, res, (error) => {
          if (!capture.headSent) res.statusCode = error ? 500 : 404;
          res.end();
        }),
      ).catch((error) => capture.fail(error));
  } catch (error) {
    capture.fail(error);
  }
  return capture.response;
}
