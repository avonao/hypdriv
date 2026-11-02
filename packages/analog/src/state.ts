/**
 * What the Vite plugin learns from the resolved config and the Nitro module needs at build time. Analog builds
 * Nitro from inside Vite's `buildApp`, in the same process, after `configResolved`; a process-wide slot keeps the two
 * pieces connected even when the module is loaded twice (Vite bundles `vite.config.ts` separately).
 */
export interface AnalogViteState {
  /** The Vite project root. */
  root?: string;
  /** The client environment's output directory (where `.vite/manifest.json` lives). */
  clientOutDir?: string;
  /** The client build's `assetsDir` (default `assets`). */
  assetsDir?: string;
  /** The Vite `base` (default `/`). */
  base?: string;
  /** Whether the client build writes a manifest. */
  manifest?: boolean;
}

const KEY = Symbol.for('hypdriv.analog.vite');

/** The shared Vite state of this process. */
export function viteState(): AnalogViteState {
  const holder = globalThis as { [KEY]?: AnalogViteState };
  holder[KEY] ??= {};
  return holder[KEY];
}

/** Clears the shared state (tests). */
export function resetViteState(): void {
  (globalThis as { [KEY]?: AnalogViteState })[KEY] = {};
}
