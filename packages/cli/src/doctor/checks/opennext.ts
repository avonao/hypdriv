import { statSync } from 'node:fs';
import { join } from 'node:path';
import { findPackageDir } from '../../project';
import { atLeast, compareVersions, parseVersion } from '../../semver';
import { mtimeMs, readJsonFile, rel } from '../../util/fs';
import { type Check, fail, info, pass, skip, warn } from '../types';

export const MIN_OPENNEXT = '1.15.0';

/** Evaluates `>=a <b`, `^a`, `~a`, exact and `||` ranges against a version (good enough for peer ranges). */
export function satisfiesSimpleRange(version: string, range: string): boolean | null {
  const v = parseVersion(version);
  if (!v) return null;
  const alternatives = range
    .split('||')
    .map((r) => r.trim())
    .filter(Boolean);
  if (!alternatives.length) return null;
  let evaluated = false;
  for (const alt of alternatives) {
    const comparators = alt.split(/\s+/).filter(Boolean);
    let ok = true;
    for (const c of comparators) {
      const m = /^(>=|<=|>|<|\^|~|=)?v?(\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?|\*|x)$/.exec(c);
      if (!m) return null;
      if (m[2] === '*' || m[2] === 'x') continue;
      const target = parseVersion(m[2]!);
      if (!target) return null;
      const op = m[1] ?? '';
      const cmp = compareVersions(v, target);
      evaluated = true;
      switch (op) {
        case '>=':
          ok &&= cmp >= 0;
          break;
        case '>':
          ok &&= cmp > 0;
          break;
        case '<=':
          ok &&= cmp <= 0;
          break;
        case '<':
          ok &&= cmp < 0;
          break;
        case '^':
          ok &&= cmp >= 0 && (target.major > 0 ? v.major === target.major : v.minor === target.minor);
          break;
        case '~':
          ok &&= cmp >= 0 && v.major === target.major && v.minor === target.minor;
          break;
        default:
          ok &&= cmp === 0;
      }
    }
    if (ok && evaluated) return true;
  }
  return evaluated ? false : null;
}

export const opennextChecks: Check[] = [
  {
    id: 'opennext.installed',
    title: '@opennextjs/cloudflare installed',
    category: 'opennext',
    severity: 'error',
    run(ctx) {
      const on = ctx.project.opennext;
      if (!on.installed)
        return fail(
          '@opennextjs/cloudflare is not installed. Run `npx @opennextjs/cloudflare@latest migrate` (existing project) or add it with wrangler.',
          { details: ['pnpm add @opennextjs/cloudflare && pnpm add -D wrangler'] },
        );
      return pass(`@opennextjs/cloudflare ${on.installed}`);
    },
  },
  {
    id: 'opennext.version',
    title: '@opennextjs/cloudflare version',
    category: 'opennext',
    severity: 'error',
    run(ctx) {
      const v = ctx.project.opennext.installed;
      if (!v) return skip('not installed.');
      if (!atLeast(v, MIN_OPENNEXT))
        return fail(
          `@opennextjs/cloudflare ${v} is too old; Hypdriv needs ${MIN_OPENNEXT}+ (Next.js 16 support, Durable Object exports).`,
        );
      return pass(`@opennextjs/cloudflare ${v}`);
    },
  },
  {
    id: 'opennext.next-support',
    title: 'OpenNext supports the installed Next.js',
    category: 'opennext',
    severity: 'warn',
    run(ctx) {
      const next = ctx.project.next.installed;
      const dir = findPackageDir(ctx.root, '@opennextjs/cloudflare');
      if (!next || !dir) return skip('next or @opennextjs/cloudflare is not installed.');
      const pkg = readJsonFile<{ peerDependencies?: Record<string, string> }>(join(dir, 'package.json'));
      const range = pkg?.peerDependencies?.next;
      if (!range) return skip('OpenNext declares no peer range for next.');
      const ok = satisfiesSimpleRange(next, range);
      if (ok === null) return info(`OpenNext declares next ${range}; verify it covers next ${next}.`);
      if (!ok)
        return warn(
          `next ${next} is outside the range OpenNext ${ctx.project.opennext.installed} declares (${range}); upgrade @opennextjs/cloudflare.`,
        );
      return pass(`next ${next} satisfies OpenNext's peer range ${range}.`);
    },
  },
  {
    id: 'opennext.config',
    title: 'open-next.config.ts',
    category: 'opennext',
    severity: 'warn',
    run(ctx) {
      const file = ctx.project.openNextConfigFile;
      if (!file)
        return warn(
          'No open-next.config.ts; `opennextjs-cloudflare build` needs it (defineCloudflareConfig with an incremental cache for ISR).',
        );
      return pass(rel(ctx.root, file));
    },
  },
  {
    id: 'opennext.built',
    title: 'OpenNext build output',
    category: 'opennext',
    severity: 'info',
    run(ctx) {
      const file = ctx.project.openNextWorkerFile;
      if (!file)
        return info(
          'No .open-next/worker.js yet; run `opennextjs-cloudflare build` before `hypdriv analyze` and the preview.',
        );
      const age = Date.now() - statSync(file).mtimeMs;
      const hours = Math.round(age / 3600000);
      const buildIdFile = ctx.project.nextBuild ? join(ctx.project.nextBuild.dir, 'BUILD_ID') : null;
      if (buildIdFile && mtimeMs(buildIdFile) > statSync(file).mtimeMs)
        return warn(
          '.next is newer than .open-next/worker.js; rebuild with `opennextjs-cloudflare build` before previewing or analysing.',
        );
      return pass(`.open-next/worker.js (${hours < 1 ? 'built within the hour' : `${hours} h old`})`);
    },
  },
];
