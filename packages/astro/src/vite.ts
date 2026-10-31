import { configModuleCode, type HostPluginApi, VIRTUAL_CONFIG } from '@hypdriv/vite';
import type { Plugin } from 'vite';

/** The build facts the runtime hooks import (`virtual:hypdriv/astro`). */
export const VIRTUAL_ASTRO = 'virtual:hypdriv/astro';
const RESOLVED_ASTRO = `\0${VIRTUAL_ASTRO}`;
/** The application's own config module, wrapped by the Astro overlay when Astro owns the CSP. */
const VIRTUAL_CONFIG_BASE = 'virtual:hypdriv/astro-config-base';
const RESOLVED_CONFIG_BASE = `\0${VIRTUAL_CONFIG_BASE}`;
const RESOLVED_CONFIG_OVERLAY = '\0virtual:hypdriv/astro-config';

/** Astro's Vite environment that renders prerendered pages at build time. */
export const PRERENDER_ENVIRONMENT = 'prerender';

export type AstroTarget = 'cloudflare' | 'vercel' | 'node';

export interface AstroBuildFacts {
  development: boolean;
  target: AstroTarget | null;
  /** Astro's `security.csp` is enabled. */
  astroCsp: boolean;
}

/**
 * Source of `virtual:hypdriv/astro` for one Vite environment. `prerendering` is true only in the production build
 * of the `prerender` environment; in `astro dev` that environment (Cloudflare's `prerenderEnvironment: 'node'`)
 * renders real requests.
 */
export function astroModuleCode(facts: AstroBuildFacts, environment: string | undefined): string {
  return [
    `export const prerendering = ${!facts.development && environment === PRERENDER_ENVIRONMENT};`,
    `export const development = ${facts.development};`,
    `export const target = ${JSON.stringify(facts.target)};`,
    `export const astroCsp = ${facts.astroCsp};`,
    '',
  ].join('\n');
}

/**
 * Source of the config overlay served as `virtual:hypdriv/config` when Astro's `security.csp` is on: the
 * application's config with Hypdriv's CSP switched off, so one policy owner (Astro) remains on every runner —
 * the middleware, `src/fetch.ts` and a custom Cloudflare Worker entry all import this module.
 */
export function cspOverlayCode(): string {
  return [
    `import base from ${JSON.stringify(VIRTUAL_CONFIG_BASE)};`,
    'const config = { ...base, security: { ...(base.security ?? {}), csp: false } };',
    'export default config;',
    '',
  ].join('\n');
}

/**
 * The Vite plugin of the Astro integration (placed before the host plugin): serves `virtual:hypdriv/astro` per
 * environment, overlays the config module when Astro owns the CSP, and bundles Hypdriv into every server
 * environment — Astro builds a separate `prerender` environment that `ssr.noExternal` does not reach, and
 * Hypdriv's runtime entries import virtual modules, so they must never be left to Node's resolver.
 */
export function astroVitePlugin(input: { facts: () => AstroBuildFacts; host: HostPluginApi }): Plugin {
  return {
    name: 'hypdriv:astro',
    enforce: 'pre',
    sharedDuringBuild: true,
    configEnvironment(name) {
      if (name === 'client') return;
      return { resolve: { noExternal: [/^@hypdriv\//] } };
    },
    resolveId(id) {
      if (id === VIRTUAL_ASTRO) return RESOLVED_ASTRO;
      if (id === VIRTUAL_CONFIG_BASE) return RESOLVED_CONFIG_BASE;
      if (id === VIRTUAL_CONFIG && input.facts().astroCsp) return RESOLVED_CONFIG_OVERLAY;
      return null;
    },
    async load(id) {
      if (id === RESOLVED_ASTRO) {
        const environment = (this as { environment?: { name?: string } }).environment?.name;
        return astroModuleCode(input.facts(), environment);
      }
      if (id === RESOLVED_CONFIG_OVERLAY) return cspOverlayCode();
      if (id === RESOLVED_CONFIG_BASE) {
        const loaded = await input.host.config();
        if (loaded.file) this.addWatchFile(loaded.file);
        return configModuleCode(loaded);
      }
      return null;
    },
  };
}
