import { randomBytes } from 'node:crypto';
import { PRERENDER_HEADER } from '../constants';

/** Prerender options of TanStack Start (global or per page) that Hypdriv reads or sets. */
export interface StartPrerenderOptionsLike {
  enabled?: boolean;
  autoSubfolderIndex?: boolean;
  headers?: Record<string, string>;
  outputPath?: string;
}

/** The subset of `tanstackStart()` options Hypdriv reads (route discovery, prerendering, server functions). */
export interface StartOptionsLike {
  srcDirectory?: string;
  router?: {
    routesDirectory?: string;
    generatedRouteTree?: string;
    basepath?: string;
    routeFileIgnorePrefix?: string;
    routeFileIgnorePattern?: string;
    routeFilePrefix?: string;
    routeToken?: string | RegExp | object;
    indexToken?: string | RegExp | object;
    virtualRouteConfig?: unknown;
  };
  serverFns?: { base?: string };
  prerender?: StartPrerenderOptionsLike;
  pages?: Array<{ path: string; prerender?: StartPrerenderOptionsLike }>;
  spa?: { enabled?: boolean; prerender?: StartPrerenderOptionsLike };
}

/** What `withHypDriv()` registered for the build running in this process. */
export interface StartRegistration {
  /** The random per-build token Start's prerender requests carry in `x-hypdriv-prerender`. */
  token: string;
  /** The Start options as the application wrote them (before Hypdriv's additions). */
  options: StartOptionsLike;
}

const REGISTRY = Symbol.for('hypdriv.tanstack-start.registration');
const TOKEN = Symbol.for('hypdriv.tanstack-start.token');

type Registry = Record<symbol, unknown>;

/**
 * The per-build prerender token: 32 random bytes, base64url (43 characters), generated once per build process.
 * `vite build` evaluates the config again for the prerender preview server in the same process; the token stays
 * the same, and the server bundle the preview runs already embeds it.
 */
export function prerenderToken(): string {
  const registry = globalThis as Registry;
  let token = registry[TOKEN] as string | undefined;
  if (!token) {
    token = randomBytes(32).toString('base64url');
    registry[TOKEN] = token;
  }
  return token;
}

/** The registration `withHypDriv()` made in this process, if any. */
export function startRegistration(): StartRegistration | null {
  return ((globalThis as Registry)[REGISTRY] as StartRegistration | undefined) ?? null;
}

/** Test seam: forgets the registration and the token. */
export function resetStartRegistration(): void {
  const registry = globalThis as Registry;
  delete registry[REGISTRY];
  delete registry[TOKEN];
}

function withToken(prerender: StartPrerenderOptionsLike | undefined, token: string) {
  return { ...prerender, headers: { ...prerender?.headers, [PRERENDER_HEADER]: token } };
}

/**
 * Prepares TanStack Start's options for Hypdriv; wrap the object you pass to `tanstackStart()`:
 *
 * ```ts
 * tanstackStart(withHypDriv({ prerender: { enabled: true }, pages: [{ path: '/about' }] }))
 * ```
 *
 * - **Prerender requests are marked.** Every prerender request carries a random per-build token
 *   (`x-hypdriv-prerender`; also on pages and the SPA shell with their own `headers`, which replace Start's
 *   global ones), so the Hypdriv middleware lets Start render the static document untouched — no per-request
 *   nonce, request id or flag baked into a file served to everyone. The build removes the token from the server
 *   output afterwards.
 * - **Prerendered pages are written as `about.html`** (`prerender.autoSubfolderIndex: false`, unless you set it):
 *   Start's router answers `/about` and redirects `/about/` to it, and that is the path Workers Static Assets
 *   serve `about.html` under without a redirect (`about/index.html` would be redirected to `/about/`).
 * - **Route discovery follows your router options** (`srcDirectory`, `router.routesDirectory`, tokens, virtual
 *   routes), which the `hypdriv()` plugin reads from here.
 */
export function withHypDriv<T extends StartOptionsLike = StartOptionsLike>(options?: T): WithHypDriv<T> {
  const input = (options ?? {}) as T;
  const token = prerenderToken();
  (globalThis as Registry)[REGISTRY] = { token, options: input } satisfies StartRegistration;
  const prerender = {
    ...withToken(input.prerender, token),
    autoSubfolderIndex: input.prerender?.autoSubfolderIndex ?? false,
  };
  const pages = input.pages?.map((page) =>
    page.prerender?.headers ? { ...page, prerender: withToken(page.prerender, token) } : page,
  );
  const spa = input.spa ? { ...input.spa, prerender: withToken(input.spa.prerender, token) } : undefined;
  return {
    ...input,
    prerender,
    ...(pages ? { pages } : {}),
    ...(spa ? { spa } : {}),
  } as unknown as WithHypDriv<T>;
}

/** The options `withHypDriv()` returns: the application's, with the prerender marker and output format set. */
export type WithHypDriv<T extends StartOptionsLike> = Omit<T, 'prerender'> & {
  prerender: (T extends { prerender?: infer P } ? Exclude<P, undefined> : unknown) & {
    headers: Record<string, string>;
    autoSubfolderIndex: boolean;
  };
};
