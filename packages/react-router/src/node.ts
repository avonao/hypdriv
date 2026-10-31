import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HypManifest } from '@hypdriv/core';
import { createStaticHandler, sendWebResponse, toWebRequest } from '@hypdriv/vite/node';
import type { ServerBuild } from 'react-router';
import { createServerEntry, type HypDrivServer } from './server';

/**
 * `@hypdriv/react-router/node` — the production Node server for a React Router build with HypDriv: the pipeline
 * around every request (prerendered pages and other static files included, with their hash CSP), the client
 * build's assets with immutable caching, and React Router for everything else. `hypdriv-react-router-serve` runs
 * it; `react-router-serve` keeps working too (the root middleware then covers the routes only).
 */

export interface ServeOptions {
  /** The server build (default `build/server/index.js`, relative to `root`). */
  build?: string;
  /** Project root: `.hypdriv/manifest.json` and `hypdriv.config.*` are read from here (default `process.cwd()`). */
  root?: string;
  /** The client build directory (default: the server build's `assetsBuildDirectory`). */
  clientDir?: string;
  port?: number;
  host?: string;
  /** Trust `x-forwarded-proto` / `x-forwarded-host` from a reverse proxy (default `HYPDRIV_TRUST_PROXY=1`). */
  trustProxy?: boolean;
  /** Compress static files for clients that accept gzip (default true). */
  compression?: boolean;
}

export interface LoadedServer {
  server: HypDrivServer;
  build: ServerBuild;
  clientDir: string;
  /** Whether the build carries HypDriv's server entry (`export const hypdriv`). */
  entry: boolean;
  serveStatic: (request: Request) => Promise<Response | null>;
}

function readManifest(root: string): HypManifest | null {
  const file = join(root, '.hypdriv', 'manifest.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HypManifest;
  } catch {
    return null;
  }
}

function isHypDrivServer(value: unknown): value is HypDrivServer {
  return typeof value === 'object' && value !== null && typeof (value as HypDrivServer).fetch === 'function';
}

const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json|wasm)|image\/svg\+xml)/;

/** Gzips a static file response for clients that accept it. */
export function compressStatic(request: Request, response: Response): Response {
  if (!response.body || response.headers.has('content-encoding') || response.status !== 200) return response;
  const type = response.headers.get('content-type') ?? '';
  const length = Number(response.headers.get('content-length') ?? '0');
  if (!COMPRESSIBLE.test(type) || (length > 0 && length < 1024)) return response;
  if (!/\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-encoding', 'gzip');
  const vary = headers.get('vary');
  if (!vary?.toLowerCase().includes('accept-encoding'))
    headers.set('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  return new Response(response.body.pipeThrough(new CompressionStream('gzip')), {
    status: response.status,
    headers,
  });
}

/**
 * Loads a React Router server build for serving: its HypDriv server entry (Node builds with the HypDriv Vite
 * plugin export one), or — for builds without it — a server entry created from `hypdriv.config.*` and
 * `.hypdriv/manifest.json`.
 */
export async function loadServer(options: ServeOptions = {}): Promise<LoadedServer> {
  const root = resolve(options.root ?? process.cwd());
  const buildPath = resolve(root, options.build ?? join('build', 'server', 'index.js'));
  if (!existsSync(buildPath))
    throw new Error(`hypdriv: server build not found at ${buildPath}; run \`react-router build\` first`);
  const mod = (await import(pathToFileURL(buildPath).href)) as ServerBuild & { hypdriv?: unknown };
  const manifest = readManifest(root);
  let server: HypDrivServer;
  const entry = isHypDrivServer(mod.hypdriv);
  if (isHypDrivServer(mod.hypdriv)) server = mod.hypdriv;
  else {
    const { loadConfigFile } = await import('@hypdriv/core/node');
    const { resolved } = await loadConfigFile(root);
    server = createServerEntry({
      build: mod,
      config: resolved,
      manifest,
      prerenderToken: '',
      target: 'node',
    });
  }
  const assetsDir = options.clientDir ?? mod.assetsBuildDirectory ?? join('build', 'client');
  const clientDir = isAbsolute(assetsDir) ? assetsDir : resolve(root, assetsDir);
  const publicPath = mod.publicPath ?? '/';
  const spa = mod.ssr === false;
  const fallback = existsSync(join(clientDir, '__spa-fallback.html')) ? '__spa-fallback.html' : 'index.html';
  const serveStatic = createStaticHandler({
    dir: clientDir,
    immutablePrefixes: manifest?.staticFiles.immutablePrefixes ?? [
      `${publicPath.replace(/\/?$/, '/')}assets/`,
    ],
    spaFallback: spa ? fallback : null,
  });
  return { server, build: mod, clientDir, entry, serveStatic };
}

/**
 * A Node request listener for a React Router build: HypDriv's pipeline around the static files and React Router.
 */
export async function createRequestListener(
  options: ServeOptions = {},
): Promise<(req: IncomingMessage, res: ServerResponse) => void> {
  const { server, serveStatic } = await loadServer(options);
  const trustProxy = options.trustProxy ?? process.env.HYPDRIV_TRUST_PROXY === '1';
  const compression = options.compression !== false;
  return (req, res) => {
    void (async () => {
      try {
        const request = toWebRequest(req, { trustProxy });
        const response = await server.fetch(request, {
          ip: req.socket.remoteAddress ?? '0.0.0.0',
          assets: async (forwarded) => {
            const file = await serveStatic(forwarded);
            return file && compression ? compressStatic(forwarded, file) : file;
          },
        });
        await sendWebResponse(res, response, request.method);
      } catch (err) {
        console.error(err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('Internal Server Error');
        } else res.destroy(err as Error);
      }
    })();
  };
}

/** Starts the production server for a React Router build (`PORT`, `HOST` from the environment by default). */
export async function serve(options: ServeOptions = {}): Promise<Server> {
  const listener = await createRequestListener(options);
  const server = createServer(listener);
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      done();
    });
  });
  return server;
}
