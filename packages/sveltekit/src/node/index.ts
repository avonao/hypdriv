import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HypDrivConfig, HypManifest, ResolvedConfig } from '@hypdriv/core';
import { createHandler, type HypHandler } from '@hypdriv/runtime';
import { sendWebResponse } from '@hypdriv/vite/node';
import { registeredHandler } from '../handle';
import { CapturedResponse } from './response';

export { CapturedResponse } from './response';

/** adapter-node's request handler (`build/handler.js`). */
export type NodeMiddleware = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;

export interface SvelteKitListenerOptions {
  /** adapter-node's output directory (default `build`, relative to `root`). */
  dir?: string;
  /** Project root (default `process.cwd()`). */
  root?: string;
  /** The public origin of the app (`https://www.example.com`): the URL the pipeline sees. Default: from the request. */
  origin?: string;
  /** Trust `x-forwarded-proto` / `x-forwarded-host` / `x-forwarded-for` from a reverse proxy (default `HYPDRIV_TRUST_PROXY=1`). */
  trustProxy?: boolean;
  /**
   * The HypDriv handler. Default: the one the build's `handle` hook created (`hypdriv()` from
   * `@hypdriv/sveltekit/hooks`), so the server and the hook share config, manifest and state; without a hook in
   * the build, one is created from `config` / `manifest` (default `hypdriv.config.*` and `.hypdriv/manifest.json`).
   */
  handler?: HypHandler;
  config?: HypDrivConfig | ResolvedConfig;
  manifest?: HypManifest | null;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.split(',')[0]?.trim() || undefined;
}

/** The request the pipeline sees: method, URL and headers (the body stays with Node's request for SvelteKit). */
export function pipelineRequest(
  req: IncomingMessage,
  options: { origin?: string | undefined; trustProxy?: boolean } = {},
): Request {
  let origin = options.origin;
  if (!origin) {
    const protoHeader = env('PROTOCOL_HEADER')?.toLowerCase();
    const hostHeader = env('HOST_HEADER')?.toLowerCase();
    const proto =
      (protoHeader ? first(req.headers[protoHeader]) : undefined) ??
      (options.trustProxy ? first(req.headers['x-forwarded-proto']) : undefined) ??
      ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
    const host =
      (hostHeader ? first(req.headers[hostHeader]) : undefined) ??
      (options.trustProxy ? first(req.headers['x-forwarded-host']) : undefined) ??
      req.headers.host ??
      'localhost';
    origin = `${proto}://${host}`;
  }
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (name.startsWith(':')) continue; // HTTP/2 pseudo-headers
    headers.append(name, req.rawHeaders[i + 1]!);
  }
  return new Request(new URL(req.url ?? '/', origin), { method: req.method ?? 'GET', headers });
}

/** The client address the way adapter-node reads it (`ADDRESS_HEADER` + `XFF_DEPTH`), else the socket's. */
export function clientAddress(req: IncomingMessage, trustProxy = false): string | undefined {
  const header = env('ADDRESS_HEADER')?.toLowerCase();
  if (header) {
    const value = first(req.headers[header] === undefined ? undefined : String(req.headers[header]));
    if (header === 'x-forwarded-for') {
      const list = String(req.headers[header] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const depth = Number.parseInt(env('XFF_DEPTH') ?? '1', 10);
      return list[list.length - Math.max(1, depth)] ?? req.socket.remoteAddress;
    }
    return value ?? req.socket.remoteAddress;
  }
  // Behind a trusted proxy the pipeline reads the forwarded headers itself (`security.trustedProxies`).
  return trustProxy ? undefined : req.socket.remoteAddress;
}

/** Navigations are answered uncompressed so the pipeline can rewrite HTML (nonces) on the way out. */
function acceptsHtml(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-dest'] === 'document') return true;
  return String(req.headers.accept ?? '').includes('text/html');
}

async function loadHandler(options: SvelteKitListenerOptions, root: string): Promise<HypHandler> {
  if (options.handler) return options.handler;
  const registered = registeredHandler();
  if (registered) return registered;
  console.warn(
    "hypdriv: the server build has no HypDriv handle (src/hooks.server.ts: hypdriv() from '@hypdriv/sveltekit/hooks'); running the pipeline from hypdriv.config and .hypdriv/manifest.json",
  );
  let config = options.config;
  if (!config) {
    const { loadConfigFile } = await import('@hypdriv/core/node');
    config = (await loadConfigFile(root)).resolved;
  }
  let manifest = options.manifest;
  if (manifest === undefined) {
    try {
      manifest = JSON.parse(readFileSync(join(root, '.hypdriv', 'manifest.json'), 'utf8')) as HypManifest;
    } catch {
      manifest = null;
    }
  }
  return createHandler({ config, manifest, host: 'sveltekit', target: 'node' });
}

/**
 * A Node request listener that runs the HypDriv pipeline around adapter-node's complete handler (`build/handler.js`):
 * static files, prerendered pages and every response SvelteKit sends before `handle` (CSRF rejections, trailing-slash
 * redirects, `/_app` 404s) get the Drivetrain — security headers, the hash CSP of prerendered pages, rate limiting,
 * the bot shield, `/_hypdriv/*` — and the `handle` hook passes through inside it. adapter-node keeps serving files
 * (precompressed variants, ETags, ranges) and reading its environment variables (`BODY_SIZE_LIMIT`,
 * `PROTOCOL_HEADER`, `ADDRESS_HEADER`…).
 */
export async function createRequestListener(
  options: SvelteKitListenerOptions = {},
): Promise<(req: IncomingMessage, res: ServerResponse) => void> {
  const root = resolve(options.root ?? process.cwd());
  const dir = resolve(root, options.dir ?? 'build');
  const mod = (await import(pathToFileURL(join(dir, 'handler.js')).href)) as { handler?: NodeMiddleware };
  if (typeof mod.handler !== 'function')
    throw new Error(`hypdriv: ${join(dir, 'handler.js')} does not export adapter-node's handler`);
  const middleware = mod.handler;
  // Importing handler.js initialised the SvelteKit server, which loaded the hooks (and registered the handler).
  const handler = await loadHandler(options, root);
  const trustProxy = options.trustProxy ?? process.env.HYPDRIV_TRUST_PROXY === '1';

  return (req, res) => {
    void (async () => {
      try {
        if (acceptsHtml(req)) delete req.headers['accept-encoding'];
        const request = pipelineRequest(req, { origin: options.origin, trustProxy });
        const ip = clientAddress(req, trustProxy);
        const response = await handler(request, {
          ...(ip ? { ip } : {}),
          upstream: () => {
            const captured = new CapturedResponse(req);
            res.once('close', () => {
              if (!captured.writableEnded) captured.destroy();
            });
            middleware(req, captured as unknown as ServerResponse, () => {
              if (!captured.headersSent)
                captured.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
            });
            return captured.response;
          },
        });
        await sendWebResponse(res, response, req.method ?? 'GET');
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('Internal Server Error');
        } else res.destroy(err as Error);
      }
    })();
  };
}

export interface ServeOptions extends SvelteKitListenerOptions {
  /** Default `PORT`, else 3000. */
  port?: number;
  /** Default `HOST`, else `0.0.0.0`. */
  host?: string;
  /** Listen on a Unix socket instead (default `SOCKET_PATH`). */
  socketPath?: string;
  /** Seconds to wait for in-flight requests on SIGTERM/SIGINT (default `SHUTDOWN_TIMEOUT`, else 30). */
  shutdownTimeout?: number;
}

/**
 * Starts the production server for an adapter-node build with the HypDriv pipeline in front of every response:
 *
 * ```js
 * // server.js — `node server.js` instead of `node build`
 * import { serve } from '@hypdriv/sveltekit/node';
 * await serve({ dir: 'build' });
 * ```
 */
export async function serve(options: ServeOptions = {}): Promise<Server> {
  const listener = await createRequestListener(options);
  const server = createServer(listener);
  const socketPath = options.socketPath ?? env('SOCKET_PATH');
  if (socketPath) await new Promise<void>((r) => server.listen(socketPath, r));
  else {
    const port = options.port ?? Number(env('PORT') ?? 3000);
    const host = options.host ?? env('HOST') ?? '0.0.0.0';
    await new Promise<void>((r) => server.listen(port, host, r));
  }
  const timeout = (options.shutdownTimeout ?? Number(env('SHUTDOWN_TIMEOUT') ?? 30)) * 1000;
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), timeout).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}
