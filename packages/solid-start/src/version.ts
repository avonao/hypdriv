import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The version of an installed package, resolved from the project root (`null` when it cannot be found). */
export function packageVersion(root: string, name: string): string | null {
  const require = createRequire(join(root, 'package.json'));
  try {
    const file = require.resolve(`${name}/package.json`);
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? null;
  } catch {
    try {
      let dir = dirname(require.resolve(name));
      for (let i = 0; i < 8; i++) {
        const file = join(dir, 'package.json');
        if (existsSync(file)) {
          const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
          if (pkg.name === name) return pkg.version ?? null;
        }
        dir = dirname(dir);
      }
    } catch {
      // not installed
    }
    return null;
  }
}
