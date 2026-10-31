import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findRepoRoot } from '@hypdriv/core/node';
import { parseEnvKeys, vercelLinkDir } from '../project';
import { exists } from './fs';

const VERCEL_ENV_FILES = [
  '.vercel/.env.development.local',
  '.vercel/.env.production.local',
  '.vercel/.env.preview.local',
];

/**
 * Reads a variable from the process env, `.dev.vars`, `.env*` files or the env files `vercel pull` wrote next
 * to the app's Vercel link (the repository root in monorepos). Values stay in memory only.
 */
export function readSecret(
  root: string,
  env: Record<string, string | undefined>,
  name: string,
): { value: string; source: string } | null {
  if (env[name]) return { value: env[name]!, source: 'environment' };
  const linkDir = vercelLinkDir(root, findRepoRoot(root)) ?? root;
  const files = [
    ...['.dev.vars', '.env.local', '.env'].map((f) => join(root, f)),
    ...VERCEL_ENV_FILES.map((f) => join(linkDir, f)),
  ];
  for (const path of files) {
    const file = relative(root, path);
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
