import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __HYPDRIV_VERSION__: string | undefined;

let cached: string | null = null;

/** The CLI's own version: injected at build time, otherwise read from the nearest package.json. */
export function cliVersion(): string {
  if (cached) return cached;
  if (typeof __HYPDRIV_VERSION__ === 'string' && __HYPDRIV_VERSION__ !== '0.0.0') {
    cached = __HYPDRIV_VERSION__;
    return cached;
  }
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 4; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === '@hypdriv/cli' && pkg.version) {
          cached = pkg.version;
          return cached;
        }
      } catch {
        // keep walking
      }
      dir = dirname(dir);
    }
  } catch {
    // not a file URL
  }
  cached = typeof __HYPDRIV_VERSION__ === 'string' ? __HYPDRIV_VERSION__ : '0.0.0';
  return cached;
}
