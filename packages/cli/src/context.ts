import { resolve } from 'node:path';
import { type HypDrivConfig, type HypManifest, loadConfig, type ResolvedConfig } from '@hypdriv/core';
import { findProjectRoot, loadConfigFile } from '@hypdriv/core/node';
import type { ParsedArgs } from './args';
import { UsageError } from './args';
import type { IO } from './io';
import {
  DEPLOY_PLATFORMS,
  type DeployPlatform,
  type DetectOptions,
  detectProject,
  type ProjectInfo,
} from './project';
import { createUi, type Ui } from './ui';

export interface LoadedConfig {
  file: string | null;
  config: HypDrivConfig;
  resolved: ResolvedConfig;
  /** Set when the file exists but could not be loaded; `resolved` then holds the defaults. */
  error: string | null;
}

/** Thrown by commands for user-facing failures (exit code 1 unless overridden). */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** Shared state for one command invocation. */
export interface CommandContext {
  readonly io: IO;
  readonly ui: Ui;
  readonly args: ParsedArgs;
  readonly root: string;
  project(options?: DetectOptions): ProjectInfo;
  loadConfig(): Promise<LoadedConfig>;
  manifest(): HypManifest | null;
  /** The manifest, or a `CliError` explaining how to produce it. */
  requireManifest(): HypManifest;
}

/** Validates `--platform`. */
export function platformOption(args: ParsedArgs): DeployPlatform | null {
  const value = args.string('platform');
  if (value === undefined) return null;
  if (!DEPLOY_PLATFORMS.includes(value as DeployPlatform) || value === 'unknown')
    throw new UsageError(`--platform must be one of cloudflare, vercel, node (got "${value}")`);
  return value as DeployPlatform;
}

export function createContext(args: ParsedArgs, io: IO): CommandContext {
  const root = findProjectRoot(resolve(io.cwd, args.root ?? '.'));
  const platform = platformOption(args);
  const ui = createUi(io, { json: args.json, ...(args.color === false ? { color: false } : {}) });
  let projectCache: { scanned: boolean; info: ProjectInfo } | null = null;
  let configPromise: Promise<LoadedConfig> | null = null;
  const ctx: CommandContext = {
    io,
    ui,
    args,
    root,
    project(options = {}) {
      const wantScan = options.scan !== false;
      if (projectCache && (projectCache.scanned || !wantScan)) return projectCache.info;
      const info = detectProject(root, { platform, env: io.env, ...options });
      projectCache = { scanned: wantScan, info };
      return info;
    },
    loadConfig() {
      configPromise ??= (async () => {
        try {
          const loaded = await loadConfigFile(root);
          return { file: loaded.file, config: loaded.config, resolved: loaded.resolved, error: null };
        } catch (err) {
          const info = ctx.project({ scan: false });
          return {
            file: info.hypdrivConfigFile,
            config: {},
            resolved: loadConfig({}),
            error: describeConfigError(err),
          };
        }
      })();
      return configPromise;
    },
    manifest() {
      return ctx.project({ scan: false }).manifest?.data ?? null;
    },
    requireManifest() {
      const info = ctx.project({ scan: false });
      if (info.manifest?.data) return info.manifest.data;
      if (info.manifest?.error)
        throw new CliError(
          `.hypdriv/manifest.json is invalid: ${info.manifest.error}. Rebuild with \`next build\`.`,
        );
      throw new CliError(
        'No .hypdriv/manifest.json found. Run `next build` (with next.config wrapped in withHypDriv) first.',
      );
    },
  };
  return ctx;
}

function describeConfigError(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { code?: string };
  if (e.code === 'ERR_UNKNOWN_FILE_EXTENSION' || /Unknown file extension/.test(e.message ?? '')) {
    return `this Node.js version cannot import TypeScript config files natively (needs Node 22.18+ / 23.6+, or run with --experimental-strip-types): ${e.message}`;
  }
  if (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(e.message ?? '')) {
    return `an import in hypdriv.config could not be resolved (${e.message.split('\n')[0]}); install the dependencies first`;
  }
  return e.message ?? String(err);
}
