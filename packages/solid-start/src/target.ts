import type { StaticHeaderRule } from '@hypdriv/build';

/** Deployment targets Hypdriv writes static configuration for. */
export type SolidStartTarget = 'cloudflare' | 'vercel' | 'node';

/** The parts of a Nitro instance Hypdriv's Nitro module reads and writes (Nitro 3; structural, no dependency on `nitro`). */
export interface NitroLike {
  options: {
    preset: string;
    dev?: boolean;
    rootDir?: string;
    /** Absolute paths of Nitro runtime plugins (bundled into the server). */
    plugins: string[];
    /** Nitro virtual modules: available to the server bundle and the prerender build alike. */
    virtual: Record<string, string | (() => string | Promise<string>)>;
    output: { dir: string; serverDir: string; publicDir: string };
    routeRules: Record<string, Record<string, unknown> & { headers?: Record<string, string> | false }>;
  };
}

/** A Nitro module carried by a Vite plugin (`plugin.nitro`): Nitro installs it when it initialises. */
export interface NitroModuleLike {
  name: string;
  setup(nitro: NitroLike): void | Promise<void>;
}

/** The Hypdriv target a Nitro preset deploys to (`vercel`, `cloudflare_module`, `node-server`, `bun`…). */
export function targetForNitroPreset(preset: string | undefined): SolidStartTarget {
  const p = (preset ?? '').replace(/_/g, '-').toLowerCase();
  if (p.startsWith('vercel')) return 'vercel';
  if (p.startsWith('cloudflare')) return 'cloudflare';
  return 'node';
}

/**
 * Nitro `routeRules` for a Node server: the static rules that cover files Nitro serves without any Hypdriv code in
 * the way (content-hashed assets skip the pipeline). Document and catch-all rules are left out on purpose: Nitro's
 * rule headers override the application's response headers, and every page on Node answers through the Hypdriv
 * pipeline, which sets its own.
 */
export function nodeRouteRules(
  rules: StaticHeaderRule[],
): Record<string, { headers: Record<string, string> }> {
  const base = rules.find((r) => r.path === '/*')?.set ?? {};
  const out: Record<string, { headers: Record<string, string> }> = {};
  for (const rule of rules) {
    if (rule.path === '/*' || !rule.path.endsWith('/*')) continue;
    out[`${rule.path.slice(0, -2)}/**`] = { headers: { ...base, ...rule.set } };
  }
  return out;
}
