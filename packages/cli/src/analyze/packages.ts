/** Package attribution from module paths (`node_modules/.pnpm/react@19.2.0/node_modules/react/index.js`). */

export interface PackageRef {
  name: string;
  /** Version when the path encodes it (pnpm store layout), else null. */
  version: string | null;
  /** The directory that identifies this installation (for duplicate detection). */
  installDir: string;
}

const NODE_MODULES_RE = /node_modules\/((?:@[^/]+\/)?[^/@][^/]*)(?=\/|$)/g;
const PNPM_VERSION_RE = /node_modules\/\.pnpm\/((?:@[^/]+\+)?[^/@]+)@([^/_]+)(?:_[^/]*)?\//;

/** Innermost package a path belongs to, or null for application code. */
export function packageOf(path: string): PackageRef | null {
  const normalized = path.replace(/\\/g, '/');
  let last: RegExpExecArray | null = null;
  NODE_MODULES_RE.lastIndex = 0;
  let m: RegExpExecArray | null = NODE_MODULES_RE.exec(normalized);
  while (m) {
    if (m[1] !== '.pnpm' && !m[1]!.startsWith('.')) last = m;
    m = NODE_MODULES_RE.exec(normalized);
  }
  if (!last) return null;
  const name = last[1]!;
  const installDir = normalized.slice(0, last.index + last[0].length);
  let version: string | null = null;
  const pnpm = PNPM_VERSION_RE.exec(normalized);
  if (pnpm && pnpm[1]!.replace(/\+/g, '/') === name) version = pnpm[2]!;
  else {
    const semverDir = /@([0-9]+\.[0-9]+\.[0-9]+[^/]*)\//.exec(installDir);
    if (semverDir && installDir.includes(`${name}@`)) version = semverDir[1]!;
  }
  return { name, version, installDir };
}

export interface PackageTotals {
  byPackage: Array<{ name: string; bytes: number; share: number }>;
  duplicates: Array<{ name: string; versions: string[] }>;
  appBytes: number;
}

/** Aggregates per-source byte counts into packages and detects duplicate installations. */
export function aggregatePackages(
  entries: Array<{ source: string; bytes: number }>,
  total: number,
): PackageTotals {
  const totals = new Map<string, number>();
  const installs = new Map<string, Map<string, number>>();
  let appBytes = 0;
  for (const { source, bytes } of entries) {
    const pkg = packageOf(source);
    if (!pkg) {
      appBytes += bytes;
      continue;
    }
    totals.set(pkg.name, (totals.get(pkg.name) ?? 0) + bytes);
    const seen = installs.get(pkg.name) ?? new Map<string, number>();
    const key = pkg.version ?? pkg.installDir;
    seen.set(key, (seen.get(key) ?? 0) + bytes);
    installs.set(pkg.name, seen);
  }
  const byPackage = [...totals.entries()]
    .map(([name, bytes]) => ({ name, bytes, share: total ? bytes / total : 0 }))
    .sort((a, b) => b.bytes - a.bytes);
  const duplicates = [...installs.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => ({
      name,
      versions: [...versions.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { byPackage, duplicates, appBytes };
}
