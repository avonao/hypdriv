/** Where the Waku build deploys: the platform whose Hypdriv adapter and static configuration the build uses. */
export type WakuTarget = 'cloudflare' | 'vercel' | 'node';

/** The Hypdriv adapter module of each target (what `unstable_adapter` points to). */
export const ADAPTER_MODULES: Record<WakuTarget, string> = {
  cloudflare: '@hypdriv/waku/adapters/cloudflare',
  vercel: '@hypdriv/waku/adapters/vercel',
  node: '@hypdriv/waku/adapters/node',
};

type Env = Record<string, string | undefined>;

const isTarget = (value: string | undefined): value is WakuTarget =>
  value === 'cloudflare' || value === 'vercel' || value === 'node';

const truthy = (value: string | undefined): boolean => !!value && value !== '0' && value !== 'false';

const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/**
 * The deploy target of this build: `HYPDRIV_TARGET` when set, else Cloudflare when `@cloudflare/vite-plugin` is
 * among the Vite plugins (`cloudflarePlugin`), else the platform's own build environment the way Waku's default
 * adapter reads it (`VERCEL`, `CLOUDFLARE` / `WORKERS_CI`), else Node. Returns `null` for platforms Hypdriv has no
 * Waku adapter for (Netlify): Waku's own adapter stays in charge there.
 */
export function detectTarget(
  env: Env = processEnv(),
  options: { cloudflarePlugin?: boolean } = {},
): WakuTarget | null {
  if (isTarget(env.HYPDRIV_TARGET)) return env.HYPDRIV_TARGET;
  if (options.cloudflarePlugin) return 'cloudflare';
  if (truthy(env.VERCEL)) return 'vercel';
  if (truthy(env.NETLIFY)) return null;
  if (truthy(env.CLOUDFLARE) || truthy(env.WORKERS_CI)) return 'cloudflare';
  return 'node';
}

/**
 * The target the build plugin writes static configuration for: the `target` option, else `HYPDRIV_TARGET`, else
 * Cloudflare when `@cloudflare/vite-plugin` is among the Vite plugins, else the platform environment, else Node.
 */
export function resolveTarget(input: {
  option?: WakuTarget;
  cloudflarePlugin?: boolean;
  env?: Env;
}): WakuTarget {
  if (input.option) return input.option;
  return (
    detectTarget(input.env ?? processEnv(), { cloudflarePlugin: input.cloudflarePlugin === true }) ?? 'node'
  );
}
