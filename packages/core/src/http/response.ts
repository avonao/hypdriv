import { mergeHeaders } from './headers';

export interface JsonResponseInit extends ResponseInit {
  /** Pretty-print (development). */
  pretty?: boolean;
}

/** JSON response with correct content type and optional pretty printing. */
export function json(data: unknown, init: JsonResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  const body = init.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  return new Response(body, { status: init.status ?? 200, statusText: init.statusText, headers });
}

export function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
  return new Response(body, { ...init, headers });
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(body, { ...init, headers });
}

export function redirect(
  location: string | URL,
  status: 301 | 302 | 303 | 307 | 308 = 307,
  headers?: HeadersInit,
): Response {
  const h = new Headers(headers);
  h.set('location', String(location));
  return new Response(null, { status, headers: h });
}

export function noContent(headers?: HeadersInit): Response {
  return new Response(null, { status: 204, headers });
}

export function notFound(message = 'Not Found'): Response {
  return text(message, { status: 404 });
}

/** Standard problem+json error body. */
export function problem(
  status: number,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
): Response {
  return json(
    { type: 'about:blank', title, status, ...(detail ? { detail } : {}), ...extra },
    { status, headers: { 'content-type': 'application/problem+json; charset=utf-8' } },
  );
}

/** Clones a response, replacing or adding headers; keeps the stream intact. */
export function cloneResponse(
  response: Response,
  init: { status?: number; headers?: HeadersInit | Headers } = {},
): Response {
  const headers = new Headers(response.headers);
  if (init.headers) mergeHeaders(headers, init.headers);
  return new Response(response.body, {
    status: init.status ?? response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Reads a response body as text without consuming the original (tees the stream). */
export async function peekText(response: Response): Promise<{ text: string; response: Response }> {
  if (!response.body) return { text: '', response };
  const [a, b] = response.body.tee();
  const text = await new Response(a).text();
  return {
    text,
    response: new Response(b, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function isServerError(status: number): boolean {
  return status >= 500;
}
