import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Next.js ≥ 16.4 writes prerendered output to `server/route-cache/<KIND>/<sha256(route)>/$/…` whenever an
 * adapter is configured ("scoped build artifacts"). Deployment tools that read the classic layout —
 * OpenNext's cache population and Vercel's legacy builder read `server/app/**` and `server/pages/**` —
 * then find no prerenders, and pages render on demand (on workerd that means Cache Components shells
 * without their prerendered data). Because HypDriv installs an adapter only to observe the build, it
 * restores the classic layout next to the scoped one: every scoped file is copied to the classic path
 * (`$/blog.html` → `server/app/blog.html`). The `.meta` files keep their `routeCache.key`, so tools that
 * understand scoped keys (OpenNext ≥ 4.1 for Next ≥ 16.3.8) still key cache entries identically.
 *
 * Existing files are never overwritten. Returns the number of files copied.
 */
export function mirrorScopedArtifacts(serverDir: string): number {
  const routeCache = join(serverDir, 'route-cache');
  if (!existsSync(routeCache)) return 0;
  let copied = 0;
  for (const kind of safeReaddir(routeCache)) {
    const target = kind === 'PAGES' ? join(serverDir, 'pages') : join(serverDir, 'app');
    for (const hash of safeReaddir(join(routeCache, kind))) {
      const root = join(routeCache, kind, hash, '$');
      if (!existsSync(root)) continue;
      for (const file of walk(root)) {
        const rel = relative(root, file);
        if (!rel || rel.startsWith('..')) continue;
        const dest = join(target, rel);
        if (existsSync(dest)) continue;
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(file, dest);
        copied++;
      }
    }
  }
  return copied;
}

/**
 * Mirrors the scoped artifacts in the build's `server/` directory and in every standalone copy of it
 * (`.next/standalone/<project>/.next/server`, which OpenNext bundles from).
 */
export function mirrorAllScopedArtifacts(distDir: string): { dirs: string[]; copied: number } {
  const dirs = [join(distDir, 'server'), ...findStandaloneServerDirs(join(distDir, 'standalone'))];
  let copied = 0;
  const touched: string[] = [];
  for (const dir of dirs) {
    const n = mirrorScopedArtifacts(dir);
    if (n) touched.push(dir);
    copied += n;
  }
  return { dirs: touched, copied };
}

function findStandaloneServerDirs(standalone: string, depth = 0): string[] {
  if (depth > 6 || !existsSync(standalone)) return [];
  const out: string[] = [];
  const candidate = join(standalone, '.next', 'server');
  if (existsSync(join(candidate, 'route-cache'))) out.push(candidate);
  for (const name of safeReaddir(standalone)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    out.push(...findStandaloneServerDirs(join(standalone, name), depth + 1));
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile()) out.push(full);
    }
  };
  visit(dir);
  return out.sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b));
}
