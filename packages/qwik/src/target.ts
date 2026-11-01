/** Where the Qwik build deploys: the platform whose Hypdriv runtime and static configuration the build uses. */
export type QwikTarget = 'cloudflare' | 'vercel' | 'node';

/** The Hypdriv adapter module of each target (`adapters/<target>/vite.config.ts` imports it). */
export const ADAPTER_MODULES: Record<QwikTarget, string> = {
  cloudflare: '@hypdriv/qwik/adapters/cloudflare',
  vercel: '@hypdriv/qwik/adapters/vercel',
  node: '@hypdriv/qwik/adapters/node',
};

/** The server entry each target builds (`src/entry.<name>.tsx`). */
export const ENTRY_NAMES: Record<QwikTarget, string> = {
  cloudflare: 'entry.cloudflare',
  vercel: 'entry.vercel',
  node: 'entry.node',
};

/** Qwik's adapter plugins are named `vite-plugin-qwik-router-ssg-<adapter name>`. */
export const ADAPTER_PLUGIN_PREFIX = 'vite-plugin-qwik-router-ssg-';

type Env = Record<string, string | undefined>;

const isTarget = (value: string | undefined): value is QwikTarget =>
  value === 'cloudflare' || value === 'vercel' || value === 'node';

const truthy = (value: string | undefined): boolean => !!value && value !== '0' && value !== 'false';

const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/**
 * The target of an adapter plugin by its name: Hypdriv's adapters (`hypdriv-cloudflare`, `hypdriv-vercel`,
 * `hypdriv-node`) and Qwik's own for the same platforms (`cloudflare-pages`, `vercel-edge`, `node-server`).
 * `undefined` for a Qwik adapter the target list has no entry for (Netlify, AWS Lambda, Deno, Bun, static…).
 */
export function targetOfAdapter(pluginName: string): QwikTarget | undefined {
  if (!pluginName.startsWith(ADAPTER_PLUGIN_PREFIX)) return undefined;
  const name = pluginName.slice(ADAPTER_PLUGIN_PREFIX.length);
  if (name.includes('cloudflare')) return 'cloudflare';
  if (name.includes('vercel')) return 'vercel';
  if (name === 'node-server' || name.includes('node')) return 'node';
  return undefined;
}

/** Whether a Vite plugin name is a Qwik Router adapter (the server build; the client build has none). */
export const isAdapterPlugin = (pluginName: string): boolean => pluginName.startsWith(ADAPTER_PLUGIN_PREFIX);

/**
 * The target of this build from the platform's own build environment: `HYPDRIV_TARGET` when set, else Vercel when
 * `VERCEL=1`, Cloudflare when `CLOUDFLARE` or `WORKERS_CI` is set, else Node. Returns `null` for Netlify, which
 * Hypdriv has no Qwik runtime for.
 */
export function detectTarget(env: Env = processEnv()): QwikTarget | null {
  if (isTarget(env.HYPDRIV_TARGET)) return env.HYPDRIV_TARGET;
  if (truthy(env.VERCEL)) return 'vercel';
  if (truthy(env.NETLIFY)) return null;
  if (truthy(env.CLOUDFLARE) || truthy(env.WORKERS_CI)) return 'cloudflare';
  return 'node';
}

/**
 * The target the build plugin writes static configuration for: the `target` option, else the adapter plugin that
 * builds the server (what is actually built wins over the environment), else `detectTarget()`.
 */
export function resolveTarget(input: { option?: QwikTarget; adapter?: string; env?: Env }): QwikTarget {
  if (input.option) return input.option;
  const fromAdapter = input.adapter ? targetOfAdapter(input.adapter) : undefined;
  if (fromAdapter) return fromAdapter;
  return detectTarget(input.env ?? processEnv()) ?? 'node';
}
