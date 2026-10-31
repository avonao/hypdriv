/**
 * `@hypdriv/tanstack-start/server-entry` — Hypdriv as TanStack Start's server entry (`src/server.ts`), the
 * outermost layer of the server: the pipeline also wraps what Start answers before or around the request
 * middleware (its error pages for uncaught exceptions, the redirect of protocol-relative URLs). The request
 * middleware in `src/start.ts` stays registered and passes through below it (it still hands the nonce to the
 * router). Use it on Node and Vercel (Nitro); on Cloudflare Workers the Worker shell (`createStartWorker()`)
 * plays this role.
 *
 * ```ts
 * // src/server.ts
 * export { default } from '@hypdriv/tanstack-start/server-entry';
 * ```
 */
import config from 'virtual:hypdriv/config';
import { prerenderToken } from 'virtual:hypdriv/tanstack-start';
import type { HypDrivConfig, ResolvedConfig } from '@hypdriv/core';
import { type CreateHandlerOptions, createHandler, type ManifestSource, nonce } from '@hypdriv/runtime';
import startHandler, { createServerEntry, type ServerEntry } from '@tanstack/react-start/server-entry';
import { HOST_LABEL } from './constants';
import { renderedManifestSource } from './manifest';
import { isPrerenderRequest, nativeRequest, platformInput } from './middleware';

export interface HypDrivServerEntryOptions extends Omit<CreateHandlerOptions, 'config' | 'manifest'> {
  /** Default: `virtual:hypdriv/config`. */
  config?: HypDrivConfig | ResolvedConfig;
  /** Default: `virtual:hypdriv/manifest`. */
  manifest?: ManifestSource;
  /** The Start handler to wrap (default: `@tanstack/react-start/server-entry`). */
  handler?: ServerEntry;
}

type StartOptions = { context?: Record<string, unknown> } & Record<string, unknown>;

/** Creates the server entry: `{ fetch }` running the Hypdriv pipeline around TanStack Start's handler. */
export function createHypDrivServerEntry(options: HypDrivServerEntryOptions = {}): ServerEntry {
  const { config: own, manifest, handler, ...rest } = options;
  const hypdriv = createHandler({
    ...rest,
    config: own ?? config,
    manifest: renderedManifestSource(
      manifest === undefined ? () => import('virtual:hypdriv/manifest') : manifest,
    ),
    host: rest.host ?? HOST_LABEL,
  });
  const start = handler ?? startHandler;
  const fetchStart = start.fetch as (request: Request, opts?: StartOptions) => Promise<Response> | Response;
  return createServerEntry({
    async fetch(request, opts) {
      const startOptions = opts as StartOptions | undefined;
      if (isPrerenderRequest(request, prerenderToken)) return fetchStart(request, startOptions);
      return hypdriv(nativeRequest(request), {
        ...platformInput(request, startOptions?.context, hypdriv.config),
        upstream: async () => {
          const current = nonce();
          return fetchStart(
            request,
            current
              ? { ...startOptions, context: { ...startOptions?.context, nonce: current } }
              : startOptions,
          );
        },
      });
    },
  } as ServerEntry);
}

export default createHypDrivServerEntry();
