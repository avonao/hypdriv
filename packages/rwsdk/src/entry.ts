import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseJsonc } from './scan';

const WRANGLER_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
const ENTRY_CANDIDATES = ['src/worker.tsx', 'src/worker.ts', 'src/worker.jsx', 'src/worker.js'];

/** The `main` of the Wrangler config RedwoodSDK reads (`RWSDK_WRANGLER_CONFIG`, else the project's own), or null. */
export function wranglerMain(
  root: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const named = env.RWSDK_WRANGLER_CONFIG;
  const files = named
    ? [isAbsolute(named) ? named : resolve(root, named)]
    : WRANGLER_FILES.map((f) => join(root, f));
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const source = readFileSync(file, 'utf8');
      const main = file.endsWith('.toml')
        ? /^\s*main\s*=\s*["']([^"']+)["']/m.exec(source)?.[1]
        : (parseJsonc(source) as { main?: unknown }).main;
      if (typeof main === 'string' && main) return resolve(dirname(file), main);
    } catch {
      // an unreadable config: fall back to the default entry
    }
  }
  return null;
}

/**
 * The Worker entry RedwoodSDK builds: the plugin's `entry` option, else the Wrangler config's `main` (what
 * RedwoodSDK itself reads), else `src/worker.tsx`. Always an absolute path with forward slashes, like Vite's ids.
 */
export function findWorkerEntry(
  root: string,
  entry?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const path =
    (entry ? resolve(root, entry) : null) ??
    wranglerMain(root, env) ??
    ENTRY_CANDIDATES.map((c) => join(root, c)).find((c) => existsSync(c)) ??
    join(root, ENTRY_CANDIDATES[0] as string);
  return path.split('\\').join('/');
}

/** The installed RedwoodSDK version (found from the project's `node_modules`; `rwsdk` does not export its manifest). */
export function rwsdkVersion(root: string): string {
  let dir = resolve(root);
  for (;;) {
    const file = join(dir, 'node_modules', 'rwsdk', 'package.json');
    if (existsSync(file)) {
      try {
        return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
      } catch {
        return 'unknown';
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
}
