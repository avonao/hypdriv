import { requestUrl, toWebHeaders } from '@hypdriv/runtime/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { applyResponse } from './response';

export interface WebRouteOptions {
  /** Trust `x-forwarded-proto` / `x-forwarded-host` for the request URL. */
  trustProxy?: boolean;
  /** The public origin of the site, when the `Host` header cannot be trusted. */
  origin?: string;
}

/**
 * The body Fastify's content-type parser produced, as bytes for a Web `Request`: strings and Buffers as they are,
 * objects re-encoded the way their content type says (JSON, or a URL-encoded form from `@fastify/formbody`).
 */
function bodyOf(request: FastifyRequest, headers: Headers): BodyInit | null {
  const body = request.body as unknown;
  if (body === undefined || body === null) return null;
  if (typeof body === 'string' || body instanceof Uint8Array) return body as BodyInit;
  if (typeof body !== 'object') return String(body);
  if ((headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(
      Object.entries(body as Record<string, unknown>).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((v): [string, string] => [name, String(v)]),
      ),
    );
  }
  return JSON.stringify(body);
}

/**
 * Mounts a Web-standard handler (`(request: Request) => Response`) as a Fastify route handler: `jobHandler()` of
 * Hypdriv, `auth.handler` of libraries written for `fetch`, anything that takes a `Request`. The response streams
 * back without being buffered.
 *
 * Fastify has parsed the body by the time the handler runs, so the `Request`'s body is the parsed payload as
 * bytes: a string or Buffer as it is, an object re-encoded as JSON (or as a URL-encoded form for that content type).
 * To receive the exact bytes, register a parser that keeps them:
 * `app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))`.
 *
 * ```ts
 * app.post('/api/jobs', webRoute(jobHandler({ handlers: { … } })));
 * ```
 */
export function webRoute(
  handler: (request: Request) => Response | Promise<Response>,
  options: WebRouteOptions = {},
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  return async (request, reply) => {
    const method = request.raw.method?.toUpperCase() ?? 'GET';
    const headers = toWebHeaders(request.raw.headers);
    const body = method === 'GET' || method === 'HEAD' ? null : bodyOf(request, headers);
    if (body !== null) {
      // The framing headers described the bytes the client sent, not the ones re-encoded here.
      headers.delete('content-length');
      headers.delete('transfer-encoding');
    }
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort(new Error('client disconnected'));
    });
    const web = new Request(requestUrl(request.raw, options), {
      method,
      headers,
      signal: controller.signal,
      ...(body !== null ? { body } : {}),
    });
    const response = await handler(web);
    return reply.send(applyResponse(reply, response, method));
  };
}
