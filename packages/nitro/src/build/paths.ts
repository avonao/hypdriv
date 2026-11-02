import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = ['.js', '.mjs', '.ts'];

/**
 * The absolute path of one of the package's runtime files (`nitro2/plugin`, `nitro3/cloudflare-worker`…): the built
 * `.js` in `dist/runtime/` (this module is bundled into `dist/`), or the `.ts` source in `src/runtime/` when the
 * package runs from `src/` (workspace development, the `source` export condition).
 */
export function runtimeFile(name: string, from: string = import.meta.url): string {
  for (const prefix of ['./runtime/', '../runtime/']) {
    const base = fileURLToPath(new URL(`${prefix}${name}`, from));
    for (const extension of EXTENSIONS) if (existsSync(`${base}${extension}`)) return `${base}${extension}`;
  }
  return fileURLToPath(new URL(`./runtime/${name}.js`, from));
}

/** The directory that holds the package's runtime files (bundled into the application's server). */
export function packageDir(from: string = import.meta.url): string {
  const here = fileURLToPath(new URL('.', from)).replace(/[\\/]$/, '');
  // `src/build/` → `src/`; `dist/` stays.
  return /[\\/]build$/.test(here) ? here.replace(/[\\/]build$/, '') : here;
}
