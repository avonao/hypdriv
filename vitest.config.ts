import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Each package owns its own vitest.config.ts (Node or Workers runtime).
// The root config only aggregates them so `pnpm test` runs everything the
// running Node supports: a package whose `engines.node` excludes it (the
// Express, Fastify, Hono and several Vite host packages need Node 22+) is
// left out, so the CI matrix tests every package on exactly the runtimes it
// declares. HYPDRIV_TEST_ALL_ENGINES=1 runs every package regardless.

type Version = readonly [number, number, number];

function parseVersion(text: string): { version: Version; parts: number } {
  const match = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(text);
  if (!match) throw new Error(`vitest.config.ts: cannot read the version "${text}" in an engines.node range`);
  const parts = [match[1], match[2], match[3]].filter(
    (p) => p !== undefined && p !== 'x' && p !== '*',
  ).length;
  const [major, minor, patch] = [match[1], match[2], match[3]].map((p) =>
    p && /^\d+$/.test(p) ? Number(p) : 0,
  );
  return { version: [major ?? 0, minor ?? 0, patch ?? 0], parts };
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The exclusive upper bound of a partial version: `22` → 23.0.0, `22.12` → 22.13.0. */
function nextOf(version: Version, parts: number): Version {
  if (parts <= 1) return [version[0] + 1, 0, 0];
  if (parts === 2) return [version[0], version[1] + 1, 0];
  return [version[0], version[1], version[2] + 1];
}

function satisfiesComparator(comparator: string, current: Version): boolean {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator);
  if (!match?.[2]) throw new Error(`vitest.config.ts: unsupported engines.node comparator "${comparator}"`);
  const operator = match[1] ?? '=';
  const { version, parts } = parseVersion(match[2]);
  const order = compare(current, version);
  switch (operator) {
    case '>=':
      return order >= 0;
    case '>':
      return parts === 3 ? order > 0 : compare(current, nextOf(version, parts)) >= 0;
    case '<':
      return order < 0;
    case '<=':
      return parts === 3 ? order <= 0 : compare(current, nextOf(version, parts)) < 0;
    case '^': {
      const upper: Version = version[0] > 0 ? [version[0] + 1, 0, 0] : nextOf(version, Math.min(parts, 2));
      return order >= 0 && compare(current, upper) < 0;
    }
    case '~':
      return order >= 0 && compare(current, nextOf(version, Math.min(parts, 2))) < 0;
    default:
      return parts === 3 ? order === 0 : order >= 0 && compare(current, nextOf(version, parts)) < 0;
  }
}

/** `engines.node` ranges as npm writes them: comparator sets joined by `||`, hyphen ranges included. */
export function satisfiesEngines(range: string, nodeVersion: string): boolean {
  const current = parseVersion(nodeVersion.replace(/[-+].*$/, '')).version;
  return range.split('||').some((set) => {
    const trimmed = set.trim();
    if (trimmed === '' || trimmed === '*' || trimmed === 'x') return true;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
    if (hyphen?.[1] && hyphen[2]) {
      return satisfiesComparator(`>=${hyphen[1]}`, current) && satisfiesComparator(`<=${hyphen[2]}`, current);
    }
    const comparators = trimmed.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/);
    return comparators.every((comparator) => satisfiesComparator(comparator, current));
  });
}

const root = fileURLToPath(new URL('.', import.meta.url));
const runAll = process.env.HYPDRIV_TEST_ALL_ENGINES === '1';
const projects: string[] = [];
const skipped: string[] = [];

for (const dir of readdirSync(join(root, 'packages')).sort()) {
  const configs = ['vitest.config.ts', 'vitest.workers.config.ts']
    .map((file) => `packages/${dir}/${file}`)
    .filter((file) => existsSync(join(root, file)));
  if (configs.length === 0) continue;
  const manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  const engines = manifest.engines?.node;
  if (!runAll && engines && !satisfiesEngines(engines, process.versions.node)) {
    skipped.push(`${dir} (${engines})`);
    continue;
  }
  projects.push(...configs);
}

if (skipped.length > 0) {
  console.warn(
    `Node ${process.versions.node}: not testing ${skipped.length} package(s) whose engines.node excludes it: ${skipped.join(', ')}. HYPDRIV_TEST_ALL_ENGINES=1 runs them anyway.`,
  );
}

export default defineConfig({
  test: {
    projects,
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: ['**/*.test.*', '**/*.spec.*', '**/dist/**', '**/__fixtures__/**'],
    },
  },
});
