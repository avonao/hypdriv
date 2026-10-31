/** The parts of Node's `IncomingMessage` (or Nitro's in-memory request) the integration reads. */
export interface NodeRequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { encrypted?: boolean; remoteAddress?: string } | null;
  connection?: { encrypted?: boolean } | null;
  /** Nitro's in-memory request (`localFetch`) carries the fetch context here. */
  __unenv__?: UnenvContext | undefined;
}

/** The context Nitro's `localFetch` attaches to its in-memory request (the Cloudflare entry fills `_platform`). */
export interface UnenvContext {
  waitUntil?: (promise: Promise<unknown>) => void;
  _platform?: {
    cf?: Record<string, unknown>;
    cloudflare?: { env?: Record<string, unknown>; context?: { waitUntil?(promise: Promise<unknown>): void } };
  };
  [key: string]: unknown;
}

/** An h3 v1 event, structurally. */
export interface H3EventLike {
  node: { req: NodeRequestLike; res: unknown };
  context: Record<string, unknown>;
  /** h3's cache of the normalised request headers (reset after the pipeline forwards new ones). */
  _headers?: unknown;
  readonly handled?: boolean;
  readonly method?: string;
}

const PAYLOAD_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The origin of a request as Nitro sees it (`x-forwarded-proto` first, like h3's `getRequestURL`). */
export function requestOrigin(req: NodeRequestLike): string {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const encrypted = req.socket?.encrypted || req.connection?.encrypted;
  const protocol = proto === 'https' || proto === 'http' ? proto : encrypted ? 'https' : 'http';
  const hostHeader = req.headers.host;
  const host = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) || 'localhost';
  return `${protocol}://${host}`;
}

/**
 * The request as a Web `Request`. Its body is read through `readBody` (h3's `readRawBody`, which caches the bytes
 * on the request), so stages that read it and the route's own `readBody(event)` see the same bytes.
 */
export function toWebRequest(
  event: H3EventLike,
  readBody: () => Promise<Uint8Array | undefined>,
  signal?: AbortSignal,
): Request {
  const req = event.node.req;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(':')) continue;
    try {
      if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      else headers.set(name, value);
    } catch {
      // a header value Fetch refuses: the pipeline does without it
    }
  }
  const url = new URL(req.originalUrl ?? req.url ?? '/', requestOrigin(req));
  const method = (req.method ?? 'GET').toUpperCase();
  const init: RequestInit & { duplex?: 'half' } = { method, headers, ...(signal ? { signal } : {}) };
  if (PAYLOAD_METHODS.has(method)) {
    let read = false;
    init.body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (read) {
          controller.close();
          return;
        }
        read = true;
        try {
          const body = await readBody();
          if (body?.byteLength) controller.enqueue(body);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/**
 * Applies the request headers the pipeline forwards (sanitised client headers plus HypDriv's `x-hypdriv-*`, the
 * CSP nonce…) to the Node request Nitro reads. `accept-encoding` is dropped so the application answers with an
 * identity-encoded body the pipeline can transform; compression stays with the CDN or reverse proxy.
 */
export function applyForwardedHeaders(event: H3EventLike, forwarded: Headers): void {
  const target = event.node.req.headers;
  const next = new Map<string, string>();
  forwarded.forEach((value, name) => {
    next.set(name, value);
  });
  next.delete('accept-encoding');
  for (const name of Object.keys(target)) if (!next.has(name)) delete target[name];
  for (const [name, value] of next) {
    const current = target[name];
    const same = Array.isArray(current) ? current.join(', ') === value : current === value;
    if (!same) target[name] = value;
  }
  // h3 caches the normalised headers on first access.
  event._headers = undefined;
}

/**
 * Whether the event is one of Nitro's own in-memory sub-requests (`$fetch('/api/…')`, `localFetch`) made outside a
 * HypDriv request: those carry `__unenv__` without a platform context. Clients cannot produce it — it is a property
 * of the request object, not a header.
 */
export function isInternalSubRequest(req: NodeRequestLike): boolean {
  return '__unenv__' in req && !req.__unenv__?._platform;
}

/** The platform facts Nitro's Cloudflare entry hands to the in-memory request. */
export function platformOf(req: NodeRequestLike): {
  env?: Record<string, unknown>;
  waitUntil?: (promise: Promise<unknown>) => void;
  cf?: Record<string, unknown>;
} {
  const context = req.__unenv__;
  const platform = context?._platform;
  const cloudflare = platform?.cloudflare;
  const waitUntil =
    context?.waitUntil ??
    (cloudflare?.context?.waitUntil
      ? (promise: Promise<unknown>) => cloudflare.context!.waitUntil!(promise)
      : undefined);
  return {
    ...(cloudflare?.env ? { env: cloudflare.env } : {}),
    ...(waitUntil ? { waitUntil } : {}),
    ...(platform?.cf ? { cf: platform.cf } : {}),
  };
}
