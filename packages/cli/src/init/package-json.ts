import { detectEol, detectIndent } from '../util/fs';

export interface PackageJsonEditOptions {
  scripts: Record<string, string>;
  /** Dependency to add when neither it nor any `@hypdriv/*` package is declared. */
  dependency?: { name: string; range: string };
  /** Dependencies to add each when not declared yet (`dev` → devDependencies). */
  dependencies?: Array<{ name: string; range: string; dev?: boolean }>;
}

export interface PackageJsonEditResult {
  content: string;
  changes: string[];
}

/** Adds missing scripts and the `hypdriv` dependency; keeps key order, indentation and line endings. */
export function editPackageJson(source: string, options: PackageJsonEditOptions): PackageJsonEditResult {
  const pkg = JSON.parse(source) as Record<string, unknown>;
  const changes: string[] = [];
  const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<
    string,
    string
  >;
  for (const [name, command] of Object.entries(options.scripts)) {
    if (scripts[name] !== undefined) continue;
    // The project already has this command under another name (`cf:typegen` for `cf-typegen`): no twin.
    if (Object.values(scripts).some((existing) => existing.trim() === command)) continue;
    scripts[name] = command;
    changes.push(`script "${name}"`);
  }
  if (!pkg.scripts && changes.length) pkg.scripts = scripts;
  if (options.dependency) {
    const deps = (pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}) as Record<
      string,
      string
    >;
    const devDeps = (
      pkg.devDependencies && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {}
    ) as Record<string, string>;
    const declared = [...Object.keys(deps), ...Object.keys(devDeps)];
    const hasHypDriv =
      declared.includes(options.dependency.name) || declared.some((d) => d.startsWith('@hypdriv/'));
    if (!hasHypDriv) {
      deps[options.dependency.name] = options.dependency.range;
      const sorted = Object.fromEntries(
        Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      pkg.dependencies = sorted;
      changes.push(`dependency "${options.dependency.name}": "${options.dependency.range}"`);
    }
  }
  for (const dep of options.dependencies ?? []) {
    const field = dep.dev ? 'devDependencies' : 'dependencies';
    const current = (pkg[field] && typeof pkg[field] === 'object' ? pkg[field] : {}) as Record<
      string,
      string
    >;
    const other = (pkg[dep.dev ? 'dependencies' : 'devDependencies'] ?? {}) as Record<string, string>;
    if (dep.name in current || dep.name in other) continue;
    current[dep.name] = dep.range;
    pkg[field] = Object.fromEntries(Object.entries(current).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    changes.push(`${dep.dev ? 'devDependency' : 'dependency'} "${dep.name}": "${dep.range}"`);
  }
  if (!changes.length) return { content: source, changes };
  const indent = detectIndent(source);
  const eol = detectEol(source);
  let text = JSON.stringify(pkg, null, indent);
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return { content: `${text}${source.endsWith('\n') || source.endsWith('\r\n') ? eol : ''}`, changes };
}

/** Ensures the immutable `_headers` rule exists (append when the file exists without it). */
export function ensureHeadersRule(
  existing: string | null,
  rule: string,
): { content: string; changed: boolean } {
  if (existing === null) return { content: rule, changed: true };
  const normalized = existing.replace(/\r\n/g, '\n');
  if (
    /^\/_next\/static\/\*\s*$/m.test(normalized) &&
    /max-age=31536000/.test(normalized) &&
    /immutable/.test(normalized)
  ) {
    return { content: existing, changed: false };
  }
  const sep = normalized.endsWith('\n') || normalized === '' ? '' : '\n';
  return { content: `${existing}${sep}${normalized === '' ? '' : '\n'}${rule}`, changed: true };
}
