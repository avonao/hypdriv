import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { HypDrivConfig, HypManifest, ResolvedConfig } from '@hypdriv/core';
import { createHandler, type HypHandler } from '@hypdriv/runtime';

/**
 * `@hypdriv/vite/node` — serving a Vite build on Node with the Hypdriv pipeline: the Node ↔ Web bridge
 * (`toWebRequest`, `sendWebResponse`), a static file handler with content-hash caching, and `serve()`, the
 * production server `hypdriv serve` runs for plain Vite apps.
 */

/** Converts a Node request into a Web `Request` (the body streams lazily). */
export function toWebRequest(
  req: IncomingMessage,
  options: { origin?: string; trustProxy?: boolean } = {},
): Request {
  const proto =
    options.trustProxy && typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0]!.trim()
      : (req.socket as { encrypted?: boolean }).encrypted
        ? 'https'
        : 'http';
  const host =
    (options.trustProxy && typeof req.headers['x-forwarded-host'] === 'string'
      ? req.headers['x-forwarded-host'].split(',')[0]!.trim()
      : req.headers.host) ?? 'localhost';
  const origin = options.origin ?? `${proto}://${host}`;
  const url = new URL(req.url ?? '/', origin);
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (name.startsWith(':')) continue; // HTTP/2 pseudo-headers
    headers.append(name, req.rawHeaders[i + 1]!);
  }
  const method = req.method ?? 'GET';
  const controller = new AbortController();
  req.once('close', () => {
    if (!req.complete) controller.abort();
  });
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal: controller.signal };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/** Writes a Web `Response` to a Node response, streaming the body and honouring backpressure. */
export async function sendWebResponse(
  res: ServerResponse,
  response: Response,
  method = 'GET',
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  response.headers.forEach((value, name) => {
    if (name === 'set-cookie') return;
    headers[name] = value;
  });
  if (cookies.length) headers['set-cookie'] = cookies;
  // Without a status text the two-argument form: `on-headers` (behind Vite preview's `compression`) reads an
  // `undefined` second argument as the headers and drops the real ones.
  if (response.statusText) res.writeHead(response.status, response.statusText, headers);
  else res.writeHead(response.status, headers);
  if (!response.body || method === 'HEAD' || response.status === 204 || response.status === 304) {
    res.end();
    void response.body?.cancel().catch(() => undefined);
    return;
  }
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  res.once('close', abort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((r) => res.once('drain', r));
    }
    res.end();
  } catch (err) {
    res.destroy(err as Error);
  } finally {
    res.off('close', abort);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
};

export interface StaticOptions {
  /** The directory to serve (the Vite build output). */
  dir: string;
  /** Content-hashed prefixes cached for a year (`/assets/`). */
  immutablePrefixes?: string[];
  /** Serve this document for navigations that match no file (single-page apps). */
  spaFallback?: string | null;
}

/** Whether a request is a document navigation (the only requests a SPA fallback answers). */
export function isNavigation(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.headers.get('sec-fetch-mode') === 'navigate') return true;
  // Clients without Fetch Metadata (and fetch() implementations that fix `sec-fetch-mode`) ask for HTML.
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/**
 * A static file handler for a Vite build: `/x` → `x`, `x.html`, `x/index.html`; dotfiles (`.vite/`) and paths
 * outside the directory are refused; content-hashed prefixes get `immutable` caching, everything else
 * revalidates with an ETag. Returns `null` when nothing matches.
 */
export function createStaticHandler(options: StaticOptions): (request: Request) => Promise<Response | null> {
  const root = resolve(options.dir);
  const immutable = options.immutablePrefixes ?? ['/assets/'];
  const fileFor = (pathname: string): string | null => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    const segments = decoded.split('/').filter(Boolean);
    if (segments.some((s) => s === '..' || s.startsWith('.'))) return null;
    const base = join(root, ...segments);
    if (base !== root && !base.startsWith(root + sep)) return null;
    const candidates = decoded.endsWith('/')
      ? [join(base, 'index.html')]
      : [base, `${base}.html`, join(base, 'index.html')];
    for (const file of candidates) {
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // try the next spelling
      }
    }
    return null;
  };
  const respond = (request: Request, file: string, pathname: string, status = 200): Response => {
    const stat = statSync(file);
    const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = new Headers({ 'content-type': type, etag, 'last-modified': stat.mtime.toUTCString() });
    const isHtml = type.startsWith('text/html');
    if (!isHtml && immutable.some((p) => pathname.startsWith(p)))
      headers.set('cache-control', 'public, max-age=31536000, immutable');
    else headers.set('cache-control', isHtml ? 'no-cache' : 'public, max-age=0, must-revalidate');
    if (status === 200 && request.headers.get('if-none-match') === etag)
      return new Response(null, { status: 304, headers });
    headers.set('content-length', String(stat.size));
    if (request.method === 'HEAD') return new Response(null, { status, headers });
    const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, { status, headers });
  };
  const fallback = options.spaFallback ? join(root, options.spaFallback) : null;
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;
    const { pathname } = new URL(request.url);
    const file = fileFor(pathname);
    if (file) return respond(request, file, pathname);
    if (fallback && existsSync(fallback) && isNavigation(request) && !extname(pathname))
      return respond(request, fallback, pathname);
    return null;
  };
}

export interface ServeOptions {
  /** The build output directory (default `dist`). */
  dir?: string;
  /** Project root: `.hypdriv/manifest.json` and `hypdriv.config.*` are read from here (default `process.cwd()`). */
  root?: string;
  config?: HypDrivConfig | ResolvedConfig;
  manifest?: HypManifest | null;
  port?: number;
  host?: string;
  /** Trust `x-forwarded-*` from a reverse proxy (default true when `HYPDRIV_TRUST_PROXY=1`). */
  trustProxy?: boolean;
  /** Serve `index.html` for unknown navigations (default: the manifest has a catch-all page route). */
  spa?: boolean;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Creates a Node request listener that runs the Hypdriv pipeline around static file serving for a Vite build.
 */
export function createNodeListener(input: {
  handler: HypHandler;
  serveStatic: (request: Request) => Promise<Response | null>;
  trustProxy?: boolean;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        const request = toWebRequest(req, { trustProxy: input.trustProxy ?? false });
        const response = await input.handler(request, {
          ip: req.socket.remoteAddress ?? '0.0.0.0',
          upstream: async (forwarded) =>
            (await input.serveStatic(forwarded)) ??
            new Response('Not Found', {
              status: 404,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            }),
        });
        await sendWebResponse(res, response, request.method);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('Internal Server Error');
        } else res.destroy(err as Error);
      }
    })();
  };
}

/**
 * Starts the production server for a plain Vite build: static files from `dir` behind the full pipeline
 * (security headers, CSP, rate limiting, bot shield, redirects, maintenance, `/_hypdriv/*`).
 */
export async function serve(options: ServeOptions = {}): Promise<Server> {
  const root = resolve(options.root ?? process.cwd());
  const dir = resolve(root, options.dir ?? 'dist');
  let config = options.config;
  if (!config) {
    const { loadConfigFile } = await import('@hypdriv/core/node');
    config = (await loadConfigFile(root)).resolved;
  }
  const manifest =
    options.manifest !== undefined
      ? options.manifest
      : readJson<HypManifest>(join(root, '.hypdriv', 'manifest.json'));
  const spa =
    options.spa ??
    manifest?.routes.some((r) => r.kind === 'page' && /\[\.\.\.[^\]]+\]$/.test(r.pathname)) ??
    false;
  const handler = createHandler({ config, manifest: manifest ?? null, host: 'vite', target: 'node' });
  const serveStatic = createStaticHandler({
    dir,
    immutablePrefixes: manifest?.staticFiles.immutablePrefixes ?? ['/assets/'],
    spaFallback: spa ? 'index.html' : null,
  });
  const trustProxy = options.trustProxy ?? process.env.HYPDRIV_TRUST_PROXY === '1';
  const server = createServer(createNodeListener({ handler, serveStatic, trustProxy }));
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  await new Promise<void>((r) => server.listen(port, host, r));
  return server;
}
