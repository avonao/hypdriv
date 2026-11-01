import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rel } from '../../util/fs';
import { type Check, fail, info, pass, skip, warn } from '../types';

/** Waku's own server entry (explicit mode); without one Waku runs its managed entry. */
export const WAKU_SERVER_ENTRIES = ['tsx', 'ts', 'jsx', 'js', 'mjs'].map((ext) => `src/waku.server.${ext}`);

const ADAPTER = '@hypdriv/waku\\/adapters\\/(?:node|vercel|cloudflare)';

/**
 * How the Hypdriv adapter is selected, or `null` when nothing selects it (then the build runs Waku's own adapter
 * and Hypdriv's pipeline never runs): `withHypDriv()` in waku.config, an explicit `unstable_adapter`, or an
 * adapter imported in `src/waku.server.*`.
 */
export function wakuAdapterWiring(
  config: string,
  serverEntry: string | null,
): 'withHypDriv' | 'unstable_adapter' | 'server-entry' | null {
  if (/\bwithHypDriv\s*\(/.test(config)) return 'withHypDriv';
  if (new RegExp(`unstable_adapter\\s*:\\s*['"\`]${ADAPTER}['"\`]`).test(config)) return 'unstable_adapter';
  if (serverEntry && new RegExp(ADAPTER).test(serverEntry)) return 'server-entry';
  return null;
}

/**
 * Whether waku.config registers `@cloudflare/vite-plugin` for Waku's server environments: the Worker runs the RSC
 * environment, with SSR as its child (Waku's Cloudflare guide).
 */
export function wakuCloudflarePlugin(config: string): 'ok' | 'missing' | 'environment' {
  if (!/@cloudflare\/vite-plugin/.test(config) || !/\bcloudflare\s*\(/.test(config)) return 'missing';
  return /viteEnvironment\s*:\s*\{[^}]*\bname\s*:\s*['"]rsc['"]/.test(config) ? 'ok' : 'environment';
}

/** Whether a Waku version is one this Hypdriv release supports (`>=1.0.0-rc.4 <2`). */
export function wakuVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version);
  if (!match) return true;
  if (Number(match[1]) !== 1) return false;
  const pre = match[4];
  if (!pre) return true;
  const rc = /^rc\.(\d+)$/.exec(pre);
  // 1.0.0 alphas, betas and early release candidates predate the server-entry adapter API.
  if (Number(match[2]) > 0 || Number(match[3]) > 0) return true;
  return rc ? Number(rc[1]) >= 4 : false;
}

function serverEntry(root: string): { file: string; source: string } | null {
  for (const candidate of WAKU_SERVER_ENTRIES) {
    const file = join(root, candidate);
    if (existsSync(file)) return { file, source: readFileSync(file, 'utf8') };
  }
  return null;
}

export const wakuChecks: Check[] = [
  {
    id: 'waku.adapter',
    title: 'Hypdriv adapter selected',
    category: 'waku',
    severity: 'error',
    frameworks: ['waku'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      const entry = serverEntry(ctx.root);
      if (!file && !entry) return skip('no waku.config or src/waku.server found.');
      const config = file ? readFileSync(file, 'utf8') : '';
      const wiring = wakuAdapterWiring(config, entry?.source ?? null);
      if (wiring === 'withHypDriv')
        return pass(`withHypDriv() in ${rel(ctx.root, file as string)} selects the adapter.`);
      if (wiring === 'unstable_adapter')
        return pass(`unstable_adapter in ${rel(ctx.root, file as string)} selects the adapter.`);
      if (wiring === 'server-entry')
        return pass(`${rel(ctx.root, entry?.file as string)} uses a Hypdriv adapter.`);
      return fail(
        `Nothing selects Hypdriv's adapter, so the build runs Waku's own and the pipeline never runs: wrap the config with \`withHypDriv()\` from '@hypdriv/waku' in waku.config.ts (or set unstable_adapter to '@hypdriv/waku/adapters/<node|vercel|cloudflare>').`,
      );
    },
  },
  {
    id: 'waku.cloudflare-plugin',
    title: '@cloudflare/vite-plugin on Waku’s RSC environment',
    category: 'waku',
    severity: 'error',
    frameworks: ['waku'],
    platforms: ['cloudflare'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      if (!file) return skip('no waku.config found.');
      const verdict = wakuCloudflarePlugin(readFileSync(file, 'utf8'));
      if (verdict === 'ok')
        return pass(`${rel(ctx.root, file)} registers cloudflare() for the rsc environment.`);
      if (verdict === 'environment')
        return fail(
          `${rel(ctx.root, file)} registers cloudflare() without \`viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] }\`: Waku renders in the rsc environment.`,
        );
      return fail(
        `${rel(ctx.root, file)} does not register @cloudflare/vite-plugin; add \`vite: { plugins: [cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } })] }\`.`,
      );
    },
  },
  {
    id: 'waku.worker-main',
    title: 'Worker main is Waku’s server entry',
    category: 'waku',
    severity: 'warn',
    frameworks: ['waku'],
    platforms: ['cloudflare'],
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      if (!cfg.main)
        return warn(
          'wrangler has no `main`; Waku on Workers uses "main": "./src/waku.server" (its server entry).',
        );
      if (!/(^|\/)waku\.server(\.[cm]?[jt]sx?)?$/.test(cfg.main))
        return warn(
          `wrangler main is ${cfg.main}; Waku's Cloudflare build expects "./src/waku.server" (the file, or Waku's managed entry when the project has none).`,
        );
      const own = serverEntry(ctx.root);
      return pass(
        own
          ? `main ${cfg.main} is ${rel(ctx.root, own.file)}.`
          : `main ${cfg.main}: Waku's managed server entry (no waku.server file); @hypdriv/waku exports the Durable Objects.`,
      );
    },
  },
  {
    id: 'waku.version',
    title: 'Supported Waku version',
    category: 'waku',
    severity: 'warn',
    frameworks: ['waku'],
    run(ctx) {
      const version = ctx.project.framework.version;
      if (!version) return skip('Waku version unknown.');
      if (!wakuVersionSupported(version))
        return warn(
          `Waku ${version} is outside @hypdriv/waku's range (>=1.0.0-rc.4 <2): the server-entry adapter API Hypdriv wraps may differ.`,
        );
      return /-/.test(version)
        ? info(
            `Waku ${version} is a pre-release; Hypdriv follows its adapter API (unstable_*) between releases.`,
          )
        : pass(`Waku ${version}.`);
    },
  },
];
