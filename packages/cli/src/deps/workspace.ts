import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export type DependencySection = 'dependencies' | 'devDependencies' | 'optionalDependencies';

export interface WorkspaceDependency {
  name: string;
  /** Range as it appears after alias/catalog resolution (`^1.2.3`). */
  range: string;
  /** The raw specifier in package.json (`catalog:`, `npm:x@^1`). */
  raw: string;
  section: DependencySection;
  /** Catalog name when the specifier is `catalog:`; `default` for the unnamed catalog. */
  catalog: string | null;
  /** Real package name when `npm:` aliased. */
  alias: string | null;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  file: string;
  /** Path relative to the workspace root (`.` for the root). */
  path: string;
  dependencies: WorkspaceDependency[];
}

export interface CatalogEntry {
  range: string;
  /** 1-based line in pnpm-workspace.yaml. */
  line: number;
}

export interface Workspace {
  root: string;
  yamlFile: string | null;
  packages: WorkspacePackage[];
  /** `default` plus named catalogs. */
  catalogs: Record<string, Record<string, CatalogEntry>>;
}

interface YamlInfo {
  patterns: string[];
  catalogs: Record<string, Record<string, CatalogEntry>>;
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** Reads `packages`, `catalog` and `catalogs` from pnpm-workspace.yaml (the subset pnpm defines there). */
export function parseWorkspaceYaml(text: string): YamlInfo {
  const info: YamlInfo = { patterns: [], catalogs: {} };
  const lines = text.split(/\r?\n/);
  let section: 'packages' | 'catalog' | 'catalogs' | null = null;
  let namedCatalog: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      section = m[1] === 'packages' ? 'packages' : m[1] === 'catalog' ? 'catalog' : m[1] === 'catalogs' ? 'catalogs' : null;
      namedCatalog = null;
      if (section === 'packages' && m[2]?.startsWith('[')) info.patterns.push(...m[2].replace(/^\[|\]$/g, '').split(',').map((p) => unquote(p)).filter(Boolean));
      continue;
    }
    if (section === 'packages') {
      const m = /^\s*-\s*(.+)$/.exec(line);
      if (m) info.patterns.push(unquote(m[1]!));
      continue;
    }
    if (section === 'catalog') {
      const m = /^\s*("[^"]+"|'[^']+'|[^:\s]+)\s*:\s*(.+)$/.exec(line);
      if (m) (info.catalogs.default ??= {})[unquote(m[1]!)] = { range: unquote(m[2]!), line: i + 1 };
      continue;
    }
    if (section === 'catalogs') {
      const nameMatch = /^(\s*)("[^"]+"|'[^']+'|[^:\s]+)\s*:\s*$/.exec(line);
      if (nameMatch && indent === 2) {
        namedCatalog = unquote(nameMatch[2]!);
        info.catalogs[namedCatalog] ??= {};
        continue;
      }
      const m = /^\s*("[^"]+"|'[^']+'|[^:\s]+)\s*:\s*(.+)$/.exec(line);
      if (m && namedCatalog) info.catalogs[namedCatalog]![unquote(m[1]!)] = { range: unquote(m[2]!), line: i + 1 };
    }
  }
  return info;
}

/** Expands workspace patterns (`packages/*`, `apps/**`, literal dirs, `!` negations) into directories. */
export function expandPatterns(root: string, patterns: string[]): string[] {
  const include = patterns.filter((p) => !p.startsWith('!'));
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const dirs = new Set<string>();
  const listDirs = (dir: string, depth: number): string[] => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      out.push(full);
      if (depth > 1) out.push(...listDirs(full, depth - 1));
    }
    return out;
  };
  for (const pattern of include) {
    const clean = pattern.replace(/\/+$/, '');
    if (clean.endsWith('/**')) for (const d of listDirs(join(root, clean.slice(0, -3)), 4)) dirs.add(d);
    else if (clean.endsWith('/*')) for (const d of listDirs(join(root, clean.slice(0, -2)), 1)) dirs.add(d);
    else if (clean === '*' || clean === '**') for (const d of listDirs(root, clean === '**' ? 4 : 1)) dirs.add(d);
    else dirs.add(join(root, clean));
  }
  const excluded = (dir: string) => {
    const relPath = relative(root, dir).split(sep).join('/');
    return exclude.some((e) => {
      const clean = e.replace(/\/+$/, '');
      if (clean.endsWith('/**')) return relPath.startsWith(clean.slice(0, -3));
      if (clean.endsWith('/*')) return relPath.startsWith(`${clean.slice(0, -2)}/`) && !relPath.slice(clean.length - 1).includes('/');
      return relPath === clean;
    });
  };
  return [...dirs].filter((d) => existsSync(join(d, 'package.json')) && !excluded(d)).sort();
}

const SKIP_PREFIXES = ['workspace:', 'link:', 'file:', 'git+', 'git:', 'github:', 'http:', 'https:', 'portal:', 'patch:'];

/** Parses one package.json specifier into a dependency record (null when it cannot be updated). */
export function parseSpecifier(name: string, raw: string, section: DependencySection, catalogs: Workspace['catalogs']): WorkspaceDependency | null {
  if (SKIP_PREFIXES.some((p) => raw.startsWith(p))) return null;
  if (raw === 'catalog:' || raw.startsWith('catalog:')) {
    const catalog = raw === 'catalog:' ? 'default' : raw.slice('catalog:'.length);
    const entry = catalogs[catalog]?.[name];
    if (!entry) return null;
    return parseAlias(name, entry.range, raw, section, catalog);
  }
  return parseAlias(name, raw, raw, section, null);
}

function parseAlias(name: string, range: string, raw: string, section: DependencySection, catalog: string | null): WorkspaceDependency | null {
  if (range.startsWith('npm:')) {
    const spec = range.slice(4);
    const at = spec.lastIndexOf('@');
    if (at <= 0) return { name: spec, range: 'latest', raw, section, catalog, alias: spec };
    return { name: spec.slice(0, at), range: spec.slice(at + 1), raw, section, catalog, alias: spec.slice(0, at) };
  }
  if (SKIP_PREFIXES.some((p) => range.startsWith(p))) return null;
  return { name, range, raw, section, catalog, alias: null };
}

/** Reads a package.json into a workspace package record. */
export function readWorkspacePackage(root: string, dir: string, catalogs: Workspace['catalogs']): WorkspacePackage | null {
  const file = join(dir, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const dependencies: WorkspaceDependency[] = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const entries = pkg[section];
    if (!entries || typeof entries !== 'object') continue;
    for (const [name, raw] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof raw !== 'string') continue;
      const dep = parseSpecifier(name, raw, section, catalogs);
      if (dep) dependencies.push(dep);
    }
  }
  const relPath = relative(root, dir).split(sep).join('/') || '.';
  return { name: typeof pkg.name === 'string' ? pkg.name : basename(dir), dir, file, path: relPath, dependencies };
}

/**
 * Reads the workspace: with `pnpm-workspace.yaml` at `root`, every matching package plus the root;
 * otherwise just the project at `root`.
 */
export function readWorkspace(root: string, options: { includeWorkspace?: boolean } = {}): Workspace {
  const yamlFile = join(root, 'pnpm-workspace.yaml');
  const hasYaml = existsSync(yamlFile);
  const yaml = hasYaml ? parseWorkspaceYaml(readFileSync(yamlFile, 'utf8')) : { patterns: [], catalogs: {} };
  const catalogs = yaml.catalogs;
  const dirs = hasYaml && options.includeWorkspace !== false ? [root, ...expandPatterns(root, yaml.patterns).filter((d) => d !== root)] : [root];
  const packages = dirs.map((d) => readWorkspacePackage(root, d, catalogs)).filter((p): p is WorkspacePackage => p !== null);
  return { root, yamlFile: hasYaml ? yamlFile : null, packages, catalogs };
}
