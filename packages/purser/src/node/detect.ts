import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { HypDrivError } from '@hypdriv/core';

/** Tokens modules looked up, in order, when `purser.tokens` is not configured. */
export const TOKENS_FILE_CANDIDATES = [
  'lib/tokens.ts',
  'lib/tokens.js',
  'src/lib/tokens.ts',
  'app/tokens.ts',
  'tokens.ts',
] as const;

/** Install hint used in diagnostics and errors. */
export const PURSER_INSTALL_HINT = 'pnpm add -D @avonao/purser typescript@^6 (or npm/yarn/bun equivalents)';

/** Hint for TypeScript 7 hosts: Purser needs the programmatic compiler API that only TS ≤ 6 ships. */
export const TYPESCRIPT6_ALIAS_HINT =
  'TypeScript 7 has no programmatic compiler API, which Purser needs to parse your source. Install TypeScript 6 under the "typescript" name, e.g. "typescript": "npm:@typescript/typescript6@^6" in package.json (keep tsgo / @typescript/native-preview for type checking), or pin typescript@^6.';

export interface PurserDetection {
  /** `@avonao/purser` resolves from the project. */
  installed: boolean;
  version: string | null;
  /** Absolute directory of the installed `@avonao/purser` package. */
  packageDir: string | null;
  /** Absolute path of `scripts/strike-count.js` when installed. */
  strikeScriptFile: string | null;
  typescriptVersion: string | null;
  /** `true` when the project's `typescript` major is below 7 (Purser needs the TS compiler API). */
  typescriptCompatible: boolean;
  /** First existing tokens module from {@link TOKENS_FILE_CANDIDATES}, relative to `projectDir`, or `null`. */
  tokensFile: string | null;
  /** Human-readable status: what is missing and how to fix it; `null` when everything is in place. */
  message: string | null;
}

/** A `require` bound to the project so optional host dependencies resolve from there (like Purser itself). */
export function hostRequire(projectDir: string): NodeJS.Require {
  return createRequire(join(resolve(projectDir), 'package.json'));
}

function readVersion(file: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Finds `<name>/package.json` by walking the `node_modules` chain up from the project directory
 * (hoisted monorepo installs included). Global folders (`NODE_PATH`, `~/.node_modules`) are
 * deliberately ignored: host dependencies must be installed in the project, which is also where
 * Purser resolves `typescript` from.
 */
export function resolvePackageJson(projectDir: string, name: string): string | null {
  let dir = resolve(projectDir);
  for (;;) {
    const file = join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (existsSync(file)) return file;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Finds the first existing tokens module candidate, relative to the (Purser) project directory. */
export function findTokensFile(projectDir: string): string | null {
  for (const candidate of TOKENS_FILE_CANDIDATES) {
    if (existsSync(join(projectDir, candidate))) return candidate;
  }
  return null;
}

/**
 * Detects the Purser installation of a project: `@avonao/purser` version, the project's TypeScript
 * version and whether Purser can use it (major < 7), the tokens module, and the strike-count script.
 * Synchronous and side-effect free; used by `createPurserBridge`, `hypdriv doctor` and `hypdriv init`.
 */
export function detectPurser(projectDir: string): PurserDetection {
  const dir = resolve(projectDir);
  const purserPkg = resolvePackageJson(dir, '@avonao/purser');
  const packageDir = purserPkg ? dirname(purserPkg) : null;
  const version = purserPkg ? readVersion(purserPkg) : null;
  const strikeScriptFile = packageDir ? join(packageDir, 'scripts', 'strike-count.js') : null;
  const tsPkg = resolvePackageJson(dir, 'typescript');
  const typescriptVersion = tsPkg ? readVersion(tsPkg) : null;
  const tsMajor = typescriptVersion ? Number.parseInt(typescriptVersion.split('.')[0] ?? '', 10) : Number.NaN;
  const typescriptCompatible = Number.isFinite(tsMajor) && tsMajor < 7;
  const tokensFile = findTokensFile(dir);

  const problems: string[] = [];
  if (!purserPkg)
    problems.push(`@avonao/purser is not installed in ${dir}. Install it with: ${PURSER_INSTALL_HINT}`);
  if (!typescriptVersion)
    problems.push(`typescript is not installed in ${dir}; Purser parses your source with it.`);
  else if (!typescriptCompatible)
    problems.push(`typescript ${typescriptVersion} found. ${TYPESCRIPT6_ALIAS_HINT}`);
  if (purserPkg && !tokensFile)
    problems.push(
      `No tokens module found (looked for ${TOKENS_FILE_CANDIDATES.join(', ')}); set purser.tokens in hypdriv.config.ts.`,
    );

  return {
    installed: Boolean(purserPkg),
    version,
    packageDir,
    strikeScriptFile: strikeScriptFile && existsSync(strikeScriptFile) ? strikeScriptFile : null,
    typescriptVersion,
    typescriptCompatible,
    tokensFile,
    message: problems.length ? problems.join(' ') : null,
  };
}

/**
 * Reads Purser's `scripts/strike-count.js` from the project's installation.
 * @throws HypDrivError `E_UNSUPPORTED` when Purser (or the script) is not installed.
 */
export function readStrikeScript(projectDir: string): string {
  const detection = detectPurser(projectDir);
  if (!detection.strikeScriptFile) {
    throw new HypDrivError(
      'E_UNSUPPORTED',
      detection.installed
        ? `@avonao/purser ${detection.version ?? ''} does not ship scripts/strike-count.js; pass strikeScript explicitly`
        : `Purser's strike-count script needs @avonao/purser installed in ${resolve(projectDir)}. ${PURSER_INSTALL_HINT}`,
      { projectDir: resolve(projectDir), installed: detection.installed },
    );
  }
  return readFileSync(detection.strikeScriptFile, 'utf8');
}
