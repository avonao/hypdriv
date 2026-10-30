import { installedVersion } from '@hypdriv/core/node';
import { fetchPackageInfos } from '../../deps/registry';
import { classifyUpdate } from '../../semver';
import { type Check, info, pass, skip, warn } from '../types';

const COMMON = ['next', 'react', 'hypdriv', '@hypdriv/next'];
const BY_PLATFORM: Record<string, string[]> = {
  cloudflare: ['@opennextjs/cloudflare', 'wrangler', '@hypdriv/cloudflare'],
  vercel: ['vercel', '@hypdriv/vercel'],
  node: [],
  unknown: ['@opennextjs/cloudflare', 'wrangler'],
};

export const depsChecks: Check[] = [
  {
    id: 'deps.outdated',
    title: 'Outdated core dependencies',
    category: 'deps',
    severity: 'warn',
    async run(ctx) {
      if (ctx.io.env.HYPDRIV_OFFLINE === '1' || ctx.io.env.CI_OFFLINE === '1')
        return skip('offline mode (HYPDRIV_OFFLINE=1).');
      const pkg = ctx.project.packageJson;
      if (!pkg) return skip('no package.json.');
      const watched = [...COMMON, ...(BY_PLATFORM[ctx.project.platform] ?? [])];
      const declared = watched.filter((n) => pkg.dependencies[n] ?? pkg.devDependencies[n]);
      if (!declared.length) return skip(`none of ${watched.join(', ')} is declared.`);
      const infos = await fetchPackageInfos(declared, {
        fetch: ctx.io.fetch,
        timeoutMs: 5000,
        concurrency: 4,
      });
      const unreachable = declared.filter((n) => infos.get(n)?.error);
      if (unreachable.length === declared.length)
        return skip(
          `registry unreachable (${infos.get(declared[0]!)?.error ?? 'network error'}); run \`hypdriv deps\` when online.`,
        );
      const majors: string[] = [];
      const minors: string[] = [];
      for (const name of declared) {
        const declaredRange = pkg.dependencies[name] ?? pkg.devDependencies[name] ?? null;
        // workspace:/catalog: ranges resolve through the installed version
        const current =
          declaredRange && /^\^|^~|^\d/.test(declaredRange)
            ? declaredRange
            : (installedVersion(ctx.root, name) ?? declaredRange);
        const latest = infos.get(name)?.latestStable ?? null;
        const diff = classifyUpdate(current, latest);
        const line = `${name}: ${current} → ${latest}`;
        if (diff === 'major') majors.push(line);
        else if (diff === 'minor' || diff === 'patch') minors.push(line);
      }
      if (majors.length)
        return warn(
          `${majors.length} major update(s) available; review the changelogs before upgrading (\`hypdriv deps --update major --only <name>\`).`,
          { details: [...majors, ...minors] },
        );
      if (minors.length)
        return info(`${minors.length} patch/minor update(s) available: \`hypdriv deps --update safe\`.`, {
          details: minors,
        });
      return pass(`${declared.join(', ')} are current.`);
    },
  },
];
