import type { HostPluginApi } from '@hypdriv/vite';
import type { RouteManifestEntryLike } from './routes';

/** Where a build deploys: decides the server entry, the static header files and the Vercel Build Output. */
export type ReactRouterTarget = 'cloudflare' | 'vercel' | 'node';

/** The parts of React Router's resolved config HypDriv reads. */
export interface ResolvedReactRouterConfigLike {
  appDirectory: string;
  basename: string;
  buildDirectory: string;
  routes: Record<string, RouteManifestEntryLike>;
  ssr: boolean | string;
  serverBuildFile?: string;
  prerender?: unknown;
}

/** What the Vite plugin of one project root shares with the preset (they load as separate module instances). */
export interface RootState {
  root: string;
  /** The running build's prerender token (set by the build's plugin instance, read by the prerender server). */
  token: string | null;
  /** The host plugin API of the build's plugin instance. */
  api: HostPluginApi | null;
  /** The deployment target the plugin decided for the build. */
  target: ReactRouterTarget | null;
  /** The runtime manifest module was bundled into a server environment of this build. */
  manifestBundled: boolean;
}

interface Registry {
  roots: Map<string, RootState>;
  /** The last React Router config the preset saw (one app per process). */
  resolved: ResolvedReactRouterConfigLike | null;
  presetInstalled: boolean;
}

const KEY = Symbol.for('hypdriv.react-router.registry');

/**
 * The process-wide registry shared by the Vite plugin and the React Router preset. React Router loads
 * `react-router.config.ts` through its own module runner, so the preset and the plugin are separate module
 * instances; they meet here.
 */
export function registry(): Registry {
  const g = globalThis as Record<symbol, Registry | undefined>;
  g[KEY] ??= { roots: new Map(), resolved: null, presetInstalled: false };
  return g[KEY];
}

export function rootState(root: string): RootState {
  const reg = registry();
  let state = reg.roots.get(root);
  if (!state) {
    state = { root, token: null, api: null, target: null, manifestBundled: false };
    reg.roots.set(root, state);
  }
  return state;
}
