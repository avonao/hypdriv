import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HypDrivError, type Logger, type ResolvedPurser, sha256Hex, silentLogger } from '@hypdriv/core';
import { MANIFEST_DIR } from '@hypdriv/core/node';
import { analyzeStylesheet } from '../analysis/stylesheet';
import {
  detectPurser,
  hostRequire,
  PURSER_INSTALL_HINT,
  type PurserDetection,
  resolvePackageJson,
  TYPESCRIPT6_ALIAS_HINT,
} from './detect';
import type {
  PurserBuildModule,
  PurserBuildOptions,
  PurserBuildResult,
  PurserDiagnostic,
  PurserWatchHandle,
} from './purser-types';

export interface PurserBridgeOptions {
  /** The HypDriv project root (where `hypdriv.config.ts` and `.hypdriv/` live). */
  projectDir: string;
  /** `resolveConfig(...).purser` (must not be `null`). */
  config: ResolvedPurser;
  log?: Logger;
  /** Loads `@avonao/purser/build`; defaults to a dynamic import resolved from the project. Test seam. */
  loadModule?: (projectDir: string) => Promise<PurserBuildModule>;
  /** Skip the TypeScript major check (when the host guarantees a compatible compiler). */
  skipTypeScriptCheck?: boolean;
}

export interface StylesheetInfo {
  /** First 16 hex characters of the SHA-256 of the stylesheet text. */
  hash: string;
  /** Declared atom classes. */
  atoms: number;
  /** UTF-8 size. */
  bytes: number;
  /** Names from the `@layer a, b, c;` statement (`[tokens, globals, atoms]`), or `[]`. */
  layers: string[];
}

/** Shape of `.hypdriv/dev/purser.json`, polled by the DevTools HUD and `/_hypdriv/dev/purser`. */
export interface PurserDevDiagnostics {
  ts: string;
  ok: boolean;
  diagnostics: Array<{
    severity: 'error' | 'warning';
    message: string;
    file: string | null;
    line: number | null;
    column: number | null;
  }>;
  stats: PurserBuildResult['stats'];
  /** Output stylesheet relative to the project, or `null` for `check()` results. */
  outFile: string | null;
  written: boolean;
  stylesheet: StylesheetInfo | null;
  purser: { version: string | null; typescript: string | null };
}

export interface WatchOptions {
  /** Write `.hypdriv/dev/purser.json` after every result (what `withHypDriv` does in dev). Default false. */
  devDiagnostics?: boolean;
}

export interface PurserBridge {
  /** The HypDriv project root. */
  readonly projectDir: string;
  /** Purser's project root (`projectDir` joined with `config.project`). */
  readonly purserProjectDir: string;
  /** The `BuildOptions` passed to Purser, derived from `ResolvedPurser`. */
  readonly options: PurserBuildOptions;
  readonly detection: PurserDetection;
  /** Absolute output stylesheet path. */
  readonly outFile: string | null;
  /** Absolute tokens module path (configured or auto-detected), or `null`. */
  readonly tokensFile: string | null;
  /** `build()` from `@avonao/purser/build`: writes `out` when the content changed. */
  build(): Promise<PurserBuildResult>;
  /** `check()`: validates without writing. */
  check(): Promise<PurserBuildResult>;
  /**
   * `watch()`: one Purser watcher per process and project directory. Later callers share it and
   * receive the last result immediately; the watcher closes when the last subscriber closes.
   */
  watch(onResult?: (result: PurserBuildResult) => void, options?: WatchOptions): Promise<PurserWatchHandle>;
  /** Writes `.hypdriv/dev/purser.json`; returns the file path. */
  writeDevDiagnostics(result: PurserBuildResult): Promise<string>;
  /** Diagnostics as `file:line:col: severity: message` lines (Purser's CLI format), project-relative. */
  formatDiagnostics(result: PurserBuildResult): string;
  /** One-line summary (`purser: wrote app/purser.css (12 files, 80 classes, …)`). */
  formatSummary(result: PurserBuildResult): string;
  /** Hash, atom count, size and layers of a stylesheet. */
  stylesheetInfo(css: string): Promise<StylesheetInfo>;
  /** Reads the output stylesheet from disk, or `null` when it does not exist. */
  readStylesheet(): Promise<string | null>;
  /** `true` when the result carries at least one error diagnostic. */
  hasErrors(result: PurserBuildResult): boolean;
}

interface WatchSubscriber {
  fn: (result: PurserBuildResult) => void;
  /** Set once the subscriber saw a result, so a late joiner is not replayed twice. */
  received: boolean;
}

interface WatchEntry {
  handle: Promise<PurserWatchHandle>;
  /** The resolved handle, so the last `close()` can stop the watcher synchronously. */
  resolved: PurserWatchHandle | null;
  subscribers: Set<WatchSubscriber>;
  last: PurserBuildResult | null;
}

const WATCHERS = Symbol.for('hypdriv.purser.watchers');

function watcherRegistry(): Map<string, WatchEntry> {
  const g = globalThis as { [WATCHERS]?: Map<string, WatchEntry> };
  if (!g[WATCHERS]) g[WATCHERS] = new Map();
  return g[WATCHERS];
}

/** Resolves `@avonao/purser/build` from the project's installation and imports it. */
export async function loadPurserBuildModule(projectDir: string): Promise<PurserBuildModule> {
  const notInstalled = (cause?: unknown) =>
    new HypDrivError(
      'E_UNSUPPORTED',
      `@avonao/purser is not installed in ${resolve(projectDir)}. Install it with: ${PURSER_INSTALL_HINT}`,
      { projectDir: resolve(projectDir), install: PURSER_INSTALL_HINT },
      cause === undefined ? {} : { cause },
    );
  const packageJson = resolvePackageJson(projectDir, '@avonao/purser');
  if (!packageJson) throw notInstalled();
  let file: string;
  try {
    // Self-reference through the package's own exports map (`./build`), independent of NODE_PATH.
    file = createRequire(packageJson).resolve('@avonao/purser/build');
  } catch {
    try {
      file = hostRequire(projectDir).resolve('@avonao/purser/build');
    } catch (cause) {
      throw notInstalled(cause);
    }
  }
  const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(file).href)) as Partial<PurserBuildModule> & {
    default?: Partial<PurserBuildModule>;
  };
  const api = typeof mod.build === 'function' ? mod : (mod.default ?? mod);
  if (typeof api.build !== 'function' || typeof api.check !== 'function' || typeof api.watch !== 'function') {
    throw new HypDrivError(
      'E_UNSUPPORTED',
      `${file} does not export build(), check() and watch(); HypDriv needs @avonao/purser >= 0.1.0`,
      { file },
    );
  }
  return api as PurserBuildModule;
}

/** Maps `ResolvedPurser` to Purser's `BuildOptions`. Exported for `hypdriv css --json` and tests. */
export function purserBuildOptions(
  projectDir: string,
  config: ResolvedPurser,
  detectedTokens: string | null,
): PurserBuildOptions {
  const purserProjectDir = resolve(projectDir, config.project);
  const options: PurserBuildOptions = {
    projectDir: purserProjectDir,
    src: [...config.src],
    out: config.out,
    prefix: config.prefix,
    salt: config.salt,
    packageName: config.packageName,
    layers: { ...config.layers },
  };
  const tokens = config.tokens ?? detectedTokens;
  if (tokens) options.tokens = tokens;
  if (config.cssModule) options.cssModule = config.cssModule;
  return options;
}

function relativeTo(root: string, file: string | null | undefined): string | null {
  if (!file) return null;
  const abs = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(root, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : abs;
}

/** Purser's CLI line format: `file:line:col: severity: message`. */
export function formatPurserDiagnostic(diagnostic: PurserDiagnostic, root: string): string {
  const file = relativeTo(root, diagnostic.file);
  const loc = file
    ? `${file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ''}: `
    : '';
  return `${loc}${diagnostic.severity}: ${diagnostic.message}`;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/**
 * Creates the bridge to `@avonao/purser/build` for a project. Detects the installation and the
 * TypeScript version first and throws a `HypDrivError('E_UNSUPPORTED')` with install instructions
 * when Purser is missing or the host only has TypeScript 7.
 */
export async function createPurserBridge(options: PurserBridgeOptions): Promise<PurserBridge> {
  const projectDir = resolve(options.projectDir);
  const config = options.config;
  const log = options.log ?? silentLogger;
  const purserProjectDir = resolve(projectDir, config.project);
  const detection = detectPurser(purserProjectDir);
  if (!detection.installed) {
    throw new HypDrivError(
      'E_UNSUPPORTED',
      `Purser CSS is enabled in hypdriv.config.ts but @avonao/purser is not installed in ${purserProjectDir}. Install it with: ${PURSER_INSTALL_HINT}`,
      { projectDir: purserProjectDir, install: PURSER_INSTALL_HINT, detection },
    );
  }
  if (!options.skipTypeScriptCheck && !detection.typescriptCompatible) {
    throw new HypDrivError(
      'E_UNSUPPORTED',
      detection.typescriptVersion
        ? `Purser cannot run with typescript ${detection.typescriptVersion}. ${TYPESCRIPT6_ALIAS_HINT}`
        : `Purser needs the "typescript" package installed in ${purserProjectDir} (it parses your source with it). ${PURSER_INSTALL_HINT}`,
      { projectDir: purserProjectDir, typescriptVersion: detection.typescriptVersion, detection },
    );
  }
  const mod = await (options.loadModule ?? loadPurserBuildModule)(purserProjectDir);
  const buildOptions = purserBuildOptions(projectDir, config, detection.tokensFile);
  const outFile = buildOptions.out ? resolve(purserProjectDir, buildOptions.out) : null;
  const tokensFile = buildOptions.tokens ? resolve(purserProjectDir, buildOptions.tokens) : null;
  const checkOptions: Omit<PurserBuildOptions, 'out'> = { ...buildOptions };
  delete (checkOptions as Partial<PurserBuildOptions>).out;

  const hasErrors = (result: PurserBuildResult) => result.diagnostics.some((d) => d.severity === 'error');

  const formatDiagnostics = (result: PurserBuildResult) =>
    result.diagnostics.map((d) => formatPurserDiagnostic(d, projectDir)).join('\n');

  const formatSummary = (result: PurserBuildResult) => {
    const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
    if (errors) {
      return `purser: ${errors} error${errors === 1 ? '' : 's'}${result.outFile ? '; stylesheet not written' : ''}`;
    }
    const s = result.stats;
    const summary = s
      ? `${s.files} files, ${s.atoms} classes, ${s.rules} rules, ${s.tokens} tokens, ${s.keyframes} keyframes`
      : 'no stats';
    if (!result.outFile) return `purser: ok (${summary})`;
    return `purser: ${result.written ? 'wrote' : 'unchanged'} ${relativeTo(projectDir, result.outFile)} (${summary})`;
  };

  const stylesheetInfo = async (css: string): Promise<StylesheetInfo> => {
    const analysis = analyzeStylesheet(css, config.prefix);
    return {
      hash: (await sha256Hex(css)).slice(0, 16),
      atoms: analysis.atoms.size,
      bytes: new TextEncoder().encode(css).byteLength,
      layers: analysis.layerStatement ?? [],
    };
  };

  const writeDevDiagnostics = async (result: PurserBuildResult): Promise<string> => {
    const file = join(projectDir, MANIFEST_DIR, 'dev', 'purser.json');
    const payload: PurserDevDiagnostics = {
      ts: new Date().toISOString(),
      ok: !hasErrors(result),
      diagnostics: result.diagnostics.map((d) => ({
        severity: d.severity,
        message: d.message,
        file: relativeTo(projectDir, d.file),
        line: d.line ?? null,
        column: d.column ?? null,
      })),
      stats: result.stats,
      outFile: relativeTo(projectDir, result.outFile),
      written: result.written,
      stylesheet: result.css ? await stylesheetInfo(result.css) : null,
      purser: { version: detection.version, typescript: detection.typescriptVersion },
    };
    await writeAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
    return file;
  };

  const report = (result: PurserBuildResult) => {
    for (const d of result.diagnostics) {
      const line = formatPurserDiagnostic(d, projectDir);
      if (d.severity === 'error') log.error(line);
      else log.warn(line);
    }
    log.info(formatSummary(result));
  };

  const build = async () => {
    const result = await mod.build(buildOptions);
    report(result);
    return result;
  };

  const check = async () => {
    const result = await mod.check(checkOptions);
    report(result);
    return result;
  };

  const watch = async (
    onResult?: (result: PurserBuildResult) => void,
    watchOptions: WatchOptions = {},
  ): Promise<PurserWatchHandle> => {
    const registry = watcherRegistry();
    const key = purserProjectDir;
    const subscriber: WatchSubscriber = {
      received: false,
      fn(result) {
        subscriber.received = true;
        report(result);
        if (watchOptions.devDiagnostics) {
          writeDevDiagnostics(result).catch((err: unknown) =>
            log.warn('purser: could not write dev diagnostics', { error: String(err) }),
          );
        }
        onResult?.(result);
      },
    };
    let entry = registry.get(key);
    if (!entry) {
      const created: WatchEntry = {
        handle: Promise.resolve({ close() {} }),
        resolved: null,
        subscribers: new Set(),
        last: null,
      };
      created.subscribers.add(subscriber);
      created.handle = mod.watch(buildOptions, (result) => {
        created.last = result;
        for (const s of [...created.subscribers]) s.fn(result);
      });
      registry.set(key, created);
      entry = created;
      try {
        created.resolved = await created.handle;
      } catch (err) {
        registry.delete(key);
        throw err;
      }
    } else {
      log.debug('purser: reusing the existing watcher', { projectDir: key });
      entry.subscribers.add(subscriber);
      await entry.handle;
      if (entry.last && !subscriber.received) subscriber.fn(entry.last);
    }
    const shared = entry;
    let closed = false;
    return {
      close() {
        if (closed) return;
        closed = true;
        shared.subscribers.delete(subscriber);
        if (shared.subscribers.size === 0 && registry.get(key) === shared) {
          registry.delete(key);
          if (shared.resolved) shared.resolved.close();
          else shared.handle.then((h) => h.close()).catch(() => undefined);
        }
      },
    };
  };

  const readStylesheet = async () => {
    if (!outFile || !existsSync(outFile)) return null;
    return readFile(outFile, 'utf8');
  };

  return {
    projectDir,
    purserProjectDir,
    options: buildOptions,
    detection,
    outFile,
    tokensFile,
    build,
    check,
    watch,
    writeDevDiagnostics,
    formatDiagnostics,
    formatSummary,
    stylesheetInfo,
    readStylesheet,
    hasErrors,
  };
}

/** For tests and process teardown: closes every shared watcher in this process. */
export async function closeAllPurserWatchers(): Promise<void> {
  const registry = watcherRegistry();
  const entries = [...registry.values()];
  registry.clear();
  await Promise.all(entries.map((e) => e.handle.then((h) => h.close()).catch(() => undefined)));
}
