import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPackageJson } from '@hypdriv/core/node';
import { atLeast } from '../../semver';
import { type Check, type CheckContext, fail, info, pass, skip, warn } from '../types';

export const MIN_NODE = '20.9.0';
export const RECOMMENDED_NODE = '22.0.0';

/** Whether the Purser bridge would run for this project (enabled, or auto-detected). */
export function purserActive(ctx: CheckContext): boolean {
  const p = ctx.config.resolved.purser;
  if (!p) return false;
  if (p.enabled === true) return true;
  if (p.enabled === false) return false;
  return (
    ctx.project.purser.installed !== null && (p.tokens !== null || ctx.project.purser.tokensFile !== null)
  );
}

export const environmentChecks: Check[] = [
  {
    id: 'env.node-version',
    title: 'Node.js version',
    category: 'environment',
    severity: 'error',
    run(ctx) {
      const v = ctx.project.node;
      if (!atLeast(v, MIN_NODE))
        return fail(`Node.js ${v} is too old; Hypdriv needs ${MIN_NODE}+ (22+ recommended).`);
      if (!atLeast(v, RECOMMENDED_NODE))
        return pass(
          `Node.js ${v} (22+ recommended: native TypeScript config loading and WebSocket for audits).`,
        );
      return pass(`Node.js ${v}`);
    },
  },
  {
    id: 'env.package-manager',
    title: 'Package manager',
    category: 'environment',
    severity: 'info',
    run(ctx) {
      const pm = ctx.project.packageManager;
      const pinned =
        ctx.project.packageJson?.packageManager ??
        readPackageJson(ctx.project.repoRoot)?.packageManager ??
        null;
      if (!pinned)
        return info(
          `${pm} detected from lockfiles; pin it with the "packageManager" field in package.json for reproducible installs.`,
        );
      return pass(`${pm} (${pinned})`);
    },
  },
  {
    id: 'env.lockfile',
    title: 'Lockfile',
    category: 'environment',
    severity: 'info',
    run(ctx) {
      const files = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];
      const found = [
        ...new Set(
          files.filter((f) => existsSync(join(ctx.project.repoRoot, f)) || existsSync(join(ctx.root, f))),
        ),
      ];
      if (found.length === 0)
        return info('No lockfile found; commit one so CI installs the versions you tested.');
      if (found.length > 1)
        return warn(
          `Several lockfiles found (${found.join(', ')}); keep only the one for ${ctx.project.packageManager}.`,
        );
      return pass(found[0]!);
    },
  },
  {
    id: 'env.typescript',
    title: 'TypeScript',
    category: 'environment',
    severity: 'warn',
    run(ctx) {
      const ts = ctx.project.typescript;
      if (!ts.installed)
        return warn(
          'TypeScript is not installed; next.config.ts, hypdriv.config.ts and hypdriv.worker.ts need it (pnpm add -D typescript).',
        );
      if (!atLeast(ts.installed, '5.9.0'))
        return warn(
          `TypeScript ${ts.installed} is older than the supported 5.9+; upgrade for Next.js 16 types.`,
        );
      return pass(`TypeScript ${ts.installed}`);
    },
  },
  {
    id: 'env.typescript-purser',
    title: 'TypeScript and Purser compatibility',
    category: 'environment',
    severity: 'error',
    run(ctx) {
      if (!purserActive(ctx)) return skip('Purser is not active.');
      const major = ctx.project.typescript.major;
      if (major === null)
        return warn('Purser needs TypeScript (programmatic compiler API); install typescript@^6.');
      if (major >= 7)
        return fail(
          `TypeScript ${ctx.project.typescript.installed} has no programmatic compiler API, which Purser needs. Install TypeScript 6 under the "typescript" name ("typescript": "npm:@typescript/typescript6@^6") or pin typescript@^6 for the build.`,
        );
      return pass(`TypeScript ${ctx.project.typescript.installed} works with Purser.`);
    },
  },
];
