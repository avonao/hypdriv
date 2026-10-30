import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvKeys } from '../project';
import { exists } from './fs';

/** Reads a variable from the process env, `.dev.vars` or `.env*` files (values stay in memory only). */
export function readSecret(
  root: string,
  env: Record<string, string | undefined>,
  name: string,
): { value: string; source: string } | null {
  if (env[name]) return { value: env[name]!, source: 'environment' };
  for (const file of ['.dev.vars', '.env.local', '.env', '.vercel/.env.development.local']) {
    const path = join(root, file);
    if (!exists(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (!parseEnvKeys(text).includes(name)) continue;
    for (const raw of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
      if (!m || m[1] !== name) continue;
      let value = m[2]!.trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        value = value.slice(1, -1);
      if (value) return { value, source: file };
    }
  }
  return null;
}
