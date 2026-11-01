import { readdirSync } from 'node:fs';
import type { HypDrivConfig } from '@hypdriv/core';
import { loadHypConfig } from '@hypdriv/vite';
import {
  type AdapterSSGOptions,
  type ServerAdapterOptions,
  viteAdapter,
} from '@qwik.dev/router/adapters/shared/vite';
import type { Plugin, UserConfig } from 'vite';

/** The origin Qwik's SSG uses when nothing names the site (canonical links and `sitemap.xml` of the build). */
export const FALLBACK_ORIGIN = 'https://example.com';

/** What every Hypdriv adapter accepts: Qwik's `ssg` option plus where the SSG origin comes from. */
export interface HypDrivAdapterOptions extends ServerAdapterOptions {
  /**
   * The Hypdriv config (a file path or an inline config) the SSG origin falls back to: `site.origin`. Default:
   * `hypdriv.config.*` in the project root.
   */
  config?: string | HypDrivConfig;
  /** Pathnames that are served as static files in addition to the ones the build finds. */
  staticPaths?: string[];
}

type Env = Record<string, string | undefined>;

const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/** `https://host` for a bare host name (`VERCEL_URL`, `CF_PAGES_URL` without a scheme). */
export function asOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * The entry modules of the server build. Qwik's adapter collects them while the server environment bundles, but
 * Vite resolves the plugins of a build environment separately from the ones that run `buildApp`, so the list can
 * be empty by the time `generate` runs: the top-level modules of the output directory are the same set.
 */
export function serverEntries(outputEntries: string[], serverOutDir: string): string[] {
  if (outputEntries.length) return outputEntries;
  try {
    return readdirSync(serverOutDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.[cm]?js$/.test(entry.name) && !entry.name.startsWith('run-ssg'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export interface GenerateInfo {
  outputEntries: string[];
  clientOutDir: string;
  clientPublicOutDir: string;
  serverOutDir: string;
  basePathname: string;
  /** Whether the app's page URLs have no trailing slash (`qwikRouter({ trailingSlash: false })`). */
  noTrailingSlash: boolean;
  warn(message: string): void;
  error(message: string): void;
}

export interface HypDrivAdapterInput {
  /** The adapter's name; the plugin is `vite-plugin-qwik-router-ssg-<name>`. */
  name: string;
  /** The origin the platform names (`ORIGIN`, `VERCEL_URL`…), if any. */
  platformOrigin?: string | undefined;
  options: HypDrivAdapterOptions;
  /** The Vite config the platform needs (conditions, SSR target, output directory). */
  config(config: UserConfig): UserConfig;
  /** Runs after static generation: writes the platform's output. */
  generate?(info: GenerateInfo): Promise<void>;
}

/**
 * A Qwik Router adapter (`viteAdapter`, the documented way to write one) for a Hypdriv target. Static generation,
 * the static path list injected into the server bundle and the cleanup of generated files are Qwik's; the adapter
 * adds the origin fallback (the Hypdriv config's `site.origin`) and the platform's output.
 */
export function hypdrivAdapter(input: HypDrivAdapterInput): Plugin[] {
  const env = processEnv();
  const holder = { origin: asOrigin(input.platformOrigin ?? env.ORIGIN ?? env.URL) ?? FALLBACK_ORIGIN };
  const explicit = Boolean(input.platformOrigin ?? env.ORIGIN ?? env.URL ?? input.options.ssg?.origin);
  let noTrailingSlash = false;

  const origin: Plugin = {
    name: `hypdriv:qwik-${input.name}`,
    enforce: 'pre',
    apply: 'build',
    async configResolved(resolved) {
      noTrailingSlash = resolved.define?.['globalThis.__NO_TRAILING_SLASH__'] === 'true';
      if (explicit) return;
      try {
        const loaded = await loadHypConfig(resolved.root, input.options.config);
        if (loaded.resolved.site.origin) holder.origin = loaded.resolved.site.origin;
      } catch {
        // no Hypdriv config yet: the fallback origin stays
      }
    },
  };

  const adapter = viteAdapter({
    name: input.name,
    get origin() {
      return holder.origin;
    },
    ...(input.options.staticPaths ? { staticPaths: input.options.staticPaths } : {}),
    ...(input.options.ssg !== undefined ? { ssg: input.options.ssg as AdapterSSGOptions | null } : {}),
    cleanStaticGenerated: true,
    config: input.config,
    ...(input.generate
      ? {
          generate: (info) =>
            input.generate!({
              ...info,
              outputEntries: serverEntries(info.outputEntries, info.serverOutDir),
              noTrailingSlash,
            }),
        }
      : {}),
  });
  return [origin, ...adapter] as Plugin[];
}
