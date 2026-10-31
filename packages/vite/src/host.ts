import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  type HypDrivConfig,
  type HypManifest,
  loadConfig,
  type ManifestFramework,
  type ResolvedConfig,
} from '@hypdriv/core';
import { findConfigFile, loadConfigFile } from '@hypdriv/core/node';
import type { Plugin, UserConfig } from 'vite';
import { developmentManifest } from './finalize';
import type { DiscoveredRoute } from './routes';

/** Virtual module ids. */
export const VIRTUAL_CONFIG = 'virtual:hypdriv/config';
export const VIRTUAL_MANIFEST = 'virtual:hypdriv/manifest';
const RESOLVED_CONFIG = `\0${VIRTUAL_CONFIG}`;
const RESOLVED_MANIFEST = `\0${VIRTUAL_MANIFEST}`;

/** The key every runtime manifest module carries so built bundles can be found and patched after the build. */
export const MANIFEST_SENTINEL_KEY = '__hypdriv';
export const MANIFEST_SENTINEL_VALUE = 'runtime-manifest';
const SENTINEL_JSON = `{"${MANIFEST_SENTINEL_KEY}":"${MANIFEST_SENTINEL_VALUE}"`;

/** The application's Hypdriv config as the plugin loaded it. */
export interface LoadedHypConfig {
  resolved: ResolvedConfig;
  raw: HypDrivConfig;
  /** The config file, when the config came from one. */
  file: string | null;
}

/** Loads `hypdriv.config.*` from the root, an explicit file, or an inline config. */
export async function loadHypConfig(root: string, option?: string | HypDrivConfig): Promise<LoadedHypConfig> {
  if (option && typeof option === 'object') return { resolved: loadConfig(option), raw: option, file: null };
  const file = option ? (isAbsolute(option) ? option : resolve(root, option)) : findConfigFile(root);
  const { config, resolved } = await loadConfigFile(root, file);
  return { resolved, raw: config, file };
}

/** Serialises a config object into JavaScript source (RegExp values survive; functions cannot cross builds). */
export function toModuleSource(value: unknown, path = 'config'): string {
  if (value === null || value === undefined) return 'undefined';
  if (value instanceof RegExp)
    return `new RegExp(${JSON.stringify(value.source)}, ${JSON.stringify(value.flags)})`;
  if (Array.isArray(value)) return `[${value.map((v, i) => toModuleSource(v, `${path}[${i}]`)).join(', ')}]`;
  if (typeof value === 'function')
    throw new TypeError(
      `hypdriv: ${path} is a function; inline configs cannot carry functions into the server bundle. Move the config into hypdriv.config.ts.`,
    );
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${toModuleSource(v, `${path}.${k}`)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}

/** Source of `virtual:hypdriv/config`. */
export function configModuleCode(loaded: LoadedHypConfig): string {
  if (loaded.file) {
    // `export default defineConfig(...)` or `export const config = ...` (what `loadConfigFile` accepts).
    let source = '';
    try {
      source = readFileSync(loaded.file, 'utf8');
    } catch {
      source = '';
    }
    const named =
      !/\bexport\s+default\b/.test(source) && /\bexport\s+(?:const|let|var)\s+config\b/.test(source);
    return named
      ? `export { config as default } from ${JSON.stringify(loaded.file)};\n`
      : `export { default } from ${JSON.stringify(loaded.file)};\n`;
  }
  return `export default ${toModuleSource(loaded.raw)};\n`;
}

/**
 * Source of `virtual:hypdriv/manifest`: the manifest as one JSON string literal whose first key is the sentinel, so
 * `patchRuntimeManifest` can replace it in built server bundles once prerendering finished.
 */
export function manifestModuleCode(manifest: HypManifest): string {
  const json = JSON.stringify({ [MANIFEST_SENTINEL_KEY]: MANIFEST_SENTINEL_VALUE, ...manifest });
  return `const manifest = /* @__PURE__ */ JSON.parse(${JSON.stringify(json)});\nexport default manifest;\n`;
}

/** Finds the string literal that holds the sentinel JSON in built code; returns its [start, end) or null. */
function findManifestLiteral(code: string, from = 0): [number, number] | null {
  const variants = [SENTINEL_JSON.replace(/"/g, '\\"'), SENTINEL_JSON];
  for (const needle of variants) {
    const at = code.indexOf(needle, from);
    if (at < 1) continue;
    const quote = code[at - 1];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    let i = at;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) return [at - 1, i + 1];
      i++;
    }
  }
  return null;
}

/** Replaces the runtime manifest in a built JavaScript source; returns null when the file carries none. */
export function replaceRuntimeManifest(code: string, manifest: HypManifest): string | null {
  const json = JSON.stringify(
    JSON.stringify({ [MANIFEST_SENTINEL_KEY]: MANIFEST_SENTINEL_VALUE, ...manifest }),
  );
  let out = code;
  let found = false;
  let from = 0;
  for (;;) {
    const span = findManifestLiteral(out, from);
    if (!span) break;
    out = out.slice(0, span[0]) + json + out.slice(span[1]);
    from = span[0] + json.length;
    found = true;
  }
  return found ? out : null;
}

const CODE_FILE = /\.(?:m?js|cjs)$/;

/**
 * Writes the final manifest into every built server file under `dirs` that embeds the runtime manifest (the
 * server bundle is built before prerendering finishes, so its manifest lacks prerendered routes, hashes and
 * assets until this runs). Returns the patched files.
 */
export function patchRuntimeManifest(dirs: string[], manifest: HypManifest): string[] {
  const patched: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' && !dir.endsWith('.func')) continue;
        walk(full);
        continue;
      }
      if (!CODE_FILE.test(e.name) || seen.has(full)) continue;
      seen.add(full);
      try {
        if (statSync(full).size > 64 * 1024 * 1024) continue;
        const code = readFileSync(full, 'utf8');
        if (!code.includes(MANIFEST_SENTINEL_VALUE)) continue;
        const next = replaceRuntimeManifest(code, manifest);
        if (next !== null && next !== code) {
          writeFileSync(full, next);
          patched.push(full);
        }
      } catch {
        // unreadable file: skip
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return patched;
}

/** Options shared by every Hypdriv Vite integration. */
export interface HostPluginOptions {
  /** Plugin name (`hypdriv:astro`). */
  name: string;
  /** The Hypdriv config: a file path (default `hypdriv.config.*` in the root) or an inline config. */
  config?: string | HypDrivConfig;
  /** The framework that builds the app. */
  framework: () => ManifestFramework;
  /** Routes known before the build output exists (development, server build). */
  routes?: () => DiscoveredRoute[] | Promise<DiscoveredRoute[]>;
  /** Packages whose server code imports the virtual modules (bundled instead of externalised). */
  noExternal?: string[];
}

/** What an integration's other hooks use from the host plugin. */
export interface HostPluginApi {
  readonly root: string;
  /** The loaded config (available from `configResolved` on). */
  config(): Promise<LoadedHypConfig>;
  /** The manifest the virtual module serves from now on (call after a build finalised it). */
  setManifest(manifest: HypManifest): void;
  manifest(): HypManifest | null;
  isBuild(): boolean;
}

/**
 * The plugin every Hypdriv Vite integration starts from: loads the Hypdriv config and serves the
 * `virtual:hypdriv/config` and `virtual:hypdriv/manifest` modules to server code.
 */
export function hostPlugin(options: HostPluginOptions): Plugin & { api: HostPluginApi } {
  let root = process.cwd();
  let command: 'build' | 'serve' = 'serve';
  let loaded: Promise<LoadedHypConfig> | null = null;
  let manifest: HypManifest | null = null;
  const load = () => {
    loaded ??= loadHypConfig(root, options.config);
    return loaded;
  };
  const api: HostPluginApi = {
    get root() {
      return root;
    },
    config: load,
    setManifest(m) {
      manifest = m;
    },
    manifest: () => manifest,
    isBuild: () => command === 'build',
  };
  const noExternal = ['@hypdriv/vite', ...(options.noExternal ?? [])];
  return {
    name: options.name,
    enforce: 'pre',
    sharedDuringBuild: true,
    api,
    config(user): UserConfig {
      const existing = user.ssr?.noExternal;
      if (existing === true) return {};
      return { ssr: { noExternal } };
    },
    configResolved(resolved) {
      root = resolved.root;
      command = resolved.command;
    },
    resolveId(id) {
      if (id === VIRTUAL_CONFIG) return RESOLVED_CONFIG;
      if (id === VIRTUAL_MANIFEST) return RESOLVED_MANIFEST;
      return null;
    },
    async load(id) {
      if (id === RESOLVED_CONFIG) {
        const cfg = await load();
        if (cfg.file) this.addWatchFile(cfg.file);
        return configModuleCode(cfg);
      }
      if (id === RESOLVED_MANIFEST) {
        if (manifest) return manifestModuleCode(manifest);
        const routes = options.routes ? await options.routes() : [];
        return manifestModuleCode(developmentManifest(options.framework(), routes));
      }
      return null;
    },
  };
}
