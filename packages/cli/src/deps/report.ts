import { readFileSync, writeFileSync } from 'node:fs';
import { bumpRange, classifyUpdate, type UpdateDiff } from '../semver';
import type { RegistryInfo } from './registry';
import type { Workspace, WorkspaceDependency, WorkspacePackage } from './workspace';

export interface OutdatedEntry {
  name: string;
  current: string;
  latest: string;
  diff: UpdateDiff;
  dev: boolean;
  /** `catalog:` entries are updated in pnpm-workspace.yaml. */
  catalog: string | null;
  section: WorkspaceDependency['section'];
  /** Real package when aliased (`npm:@typescript/typescript6@^6`). */
  alias: string | null;
}

export interface PackageReport {
  name: string;
  path: string;
  outdated: OutdatedEntry[];
}

/** The JSON document `hypdriv deps --json` prints (consumed by scripts/deps-summary.mjs). */
export interface DepsReport {
  generatedAt: string;
  packages: PackageReport[];
  /** Registry errors, by package name. */
  errors: Record<string, string>;
  /** Dependencies that are up to date, counted per workspace package. */
  current: Record<string, number>;
}

/** Builds the report from the workspace and registry lookups. */
export function buildDepsReport(
  workspace: Workspace,
  infos: Map<string, RegistryInfo>,
  options: { only?: string[]; generatedAt: string },
): DepsReport {
  const packages: PackageReport[] = [];
  const errors: Record<string, string> = {};
  const current: Record<string, number> = {};
  for (const pkg of workspace.packages) {
    const outdated: OutdatedEntry[] = [];
    let upToDate = 0;
    for (const dep of pkg.dependencies) {
      if (options.only?.length && !options.only.includes(dep.name)) continue;
      const info = infos.get(dep.name);
      if (!info) continue;
      if (info.error) {
        errors[dep.name] = info.error;
        continue;
      }
      const latest = info.latestStable ?? info.latest;
      const diff = classifyUpdate(dep.range, latest);
      if (diff === 'current') {
        upToDate++;
        continue;
      }
      outdated.push({
        name: dep.name,
        current: dep.range,
        latest: latest ?? 'unknown',
        diff,
        dev: dep.section !== 'dependencies',
        catalog: dep.catalog,
        section: dep.section,
        alias: dep.alias,
      });
    }
    current[pkg.name] = upToDate;
    packages.push({ name: pkg.name, path: pkg.path, outdated });
  }
  return { generatedAt: options.generatedAt, packages, errors, current };
}

export interface UpdateChange {
  file: string;
  name: string;
  from: string;
  to: string;
}

export type UpdateMode = 'safe' | 'major';

function eligible(entry: OutdatedEntry, mode: UpdateMode, only: string[] | undefined): boolean {
  if (only?.length && !only.includes(entry.name)) return false;
  if (entry.diff === 'unknown' || entry.diff === 'current') return false;
  if (mode === 'safe') return entry.diff === 'patch' || entry.diff === 'minor';
  return true;
}

/** Rewrites ranges in package.json files and `catalog:` lines in pnpm-workspace.yaml. Returns what changed. */
export function applyUpdates(
  workspace: Workspace,
  report: DepsReport,
  mode: UpdateMode,
  options: { only?: string[]; dryRun?: boolean } = {},
): UpdateChange[] {
  const changes: UpdateChange[] = [];
  const yamlEdits = new Map<number, { name: string; from: string; to: string }>();
  for (const pkgReport of report.packages) {
    const pkg = workspace.packages.find((p) => p.path === pkgReport.path) as WorkspacePackage | undefined;
    if (!pkg) continue;
    const json = JSON.parse(readFileSync(pkg.file, 'utf8')) as Record<string, Record<string, string>>;
    let touched = false;
    for (const entry of pkgReport.outdated) {
      if (!eligible(entry, mode, options.only)) continue;
      const next = bumpRange(entry.current, entry.latest);
      if (next === entry.current) continue;
      if (entry.catalog) {
        const catalog = workspace.catalogs[entry.catalog]?.[entry.alias ? aliasKey(pkg, entry) : entry.name];
        if (!catalog) continue;
        const to = entry.alias ? `npm:${entry.alias}@${next}` : next;
        yamlEdits.set(catalog.line, { name: entry.name, from: catalog.range, to });
        changes.push({
          file: workspace.yamlFile ?? 'pnpm-workspace.yaml',
          name: entry.name,
          from: catalog.range,
          to,
        });
        continue;
      }
      const section = json[entry.section];
      if (!section) continue;
      const key = entry.alias
        ? Object.keys(section).find((k) => section[k] === `npm:${entry.alias}@${entry.current}`)
        : entry.name;
      if (!key) continue;
      const to = entry.alias ? `npm:${entry.alias}@${next}` : next;
      changes.push({ file: pkg.file, name: entry.name, from: section[key]!, to });
      section[key] = to;
      touched = true;
    }
    if (touched && !options.dryRun) {
      const original = readFileSync(pkg.file, 'utf8');
      const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? '  ';
      writeFileSync(pkg.file, `${JSON.stringify(json, null, indent)}${original.endsWith('\n') ? '\n' : ''}`);
    }
  }
  if (yamlEdits.size && workspace.yamlFile && !options.dryRun) {
    const lines = readFileSync(workspace.yamlFile, 'utf8').split('\n');
    for (const [line, edit] of yamlEdits) {
      const idx = line - 1;
      const text = lines[idx];
      if (text === undefined) continue;
      const replaced = text.replace(edit.from, edit.to);
      lines[idx] = replaced === text ? text.replace(/:\s*.*$/, `: ${edit.to}`) : replaced;
    }
    writeFileSync(workspace.yamlFile, lines.join('\n'));
  }
  return changes;
}

function aliasKey(pkg: WorkspacePackage, entry: OutdatedEntry): string {
  const dep = pkg.dependencies.find((d) => d.alias === entry.alias && d.section === entry.section);
  return dep ? depKey(pkg, dep) : entry.name;
}

function depKey(pkg: WorkspacePackage, dep: WorkspaceDependency): string {
  const json = JSON.parse(readFileSync(pkg.file, 'utf8')) as Record<string, Record<string, string>>;
  const section = json[dep.section] ?? {};
  return Object.keys(section).find((k) => section[k] === dep.raw) ?? dep.name;
}
