import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { rel } from '../../util/fs';
import { parseJsonc } from '../../wrangler-config';
import { type Check, fail, info, pass, skip, warn } from '../types';

/** Files that can select Nitro's preset: its own config, the Vite config (Analog, Nitro 3) and package scripts. */
const PRESET_SOURCES = [
  'nitro.config.ts',
  'nitro.config.mts',
  'nitro.config.js',
  'nitro.config.mjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
  'package.json',
];

export type NitroCloudflareVerdict = 'ok' | 'no-deploy-config' | 'pages' | 'missing';

/**
 * Whether the sources select Nitro's `cloudflare-module` preset (the preset Hypdriv's Worker shell wraps) with
 * `cloudflare: { deployConfig: true }` (Nitro writes the Worker's wrangler config, with `main` and the assets
 * directory). `cloudflare-pages` builds a `_worker.js` for Pages instead and does not run Hypdriv's Worker.
 */
export function nitroCloudflareVerdict(sources: string[]): NitroCloudflareVerdict {
  const text = sources.join('\n');
  if (/cloudflare[-_]module/.test(text))
    return /\bdeployConfig\s*:\s*true/.test(text) ? 'ok' : 'no-deploy-config';
  if (/cloudflare[-_]pages/.test(text)) return 'pages';
  return 'missing';
}

/**
 * The effective `noEmit` of a tsconfig: the nearest definition along its relative `extends` chain, or `null` when
 * none sets it.
 */
export function tsconfigNoEmit(file: string, depth = 0): boolean | null {
  if (depth > 4 || !existsSync(file)) return null;
  let config: { extends?: string | string[]; compilerOptions?: { noEmit?: boolean } };
  try {
    config = parseJsonc(readFileSync(file, 'utf8')) as typeof config;
  } catch {
    return null;
  }
  const own = config.compilerOptions?.noEmit;
  if (typeof own === 'boolean') return own;
  const parents = [config.extends ?? []].flat().filter((p) => p.startsWith('.'));
  for (const parent of parents.reverse()) {
    const path = resolve(dirname(file), parent.endsWith('.json') ? parent : `${parent}.json`);
    const inherited = tsconfigNoEmit(path, depth + 1);
    if (inherited !== null) return inherited;
  }
  return null;
}

function readSources(root: string): string[] {
  return PRESET_SOURCES.map((f) => join(root, f))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, 'utf8'));
}

export const nitroChecks: Check[] = [
  {
    id: 'nitro.cloudflare-preset',
    title: 'Nitro builds the Cloudflare Worker Hypdriv wraps',
    category: 'nitro',
    severity: 'warn',
    frameworks: ['nitro', 'analog'],
    platforms: ['cloudflare'],
    run(ctx) {
      const verdict = nitroCloudflareVerdict(readSources(ctx.root));
      if (verdict === 'ok')
        return pass(
          "The preset is cloudflare-module with `cloudflare.deployConfig`: Nitro writes the Worker's wrangler config.",
        );
      if (verdict === 'no-deploy-config')
        return info(
          'cloudflare-module without `cloudflare: { deployConfig: true }`: Nitro does not write a wrangler config, so your wrangler config must point `main` at the built server (and bind the Durable Objects).',
        );
      if (verdict === 'pages')
        return warn(
          "The preset is cloudflare-pages (a Pages `_worker.js`): Hypdriv's Worker shell wraps cloudflare-module; build with `preset: 'cloudflare-module'` and `cloudflare: { deployConfig: true }`.",
        );
      return warn(
        "No cloudflare-module preset found in the Nitro/Vite config or package scripts; set `preset: 'cloudflare-module'` (or NITRO_PRESET) and `cloudflare: { deployConfig: true }` so Hypdriv's Worker shell is the Worker.",
      );
    },
  },
  {
    id: 'analog.tsconfig-emit',
    title: 'Angular compiler can emit (tsconfig.app.json)',
    category: 'nitro',
    severity: 'error',
    frameworks: ['analog'],
    run(ctx) {
      const file = join(ctx.root, 'tsconfig.app.json');
      if (!existsSync(file)) return skip('no tsconfig.app.json.');
      if (tsconfigNoEmit(file) === true)
        return fail(
          `${rel(ctx.root, file)} (or a tsconfig it extends) sets "noEmit": true: Analog's Angular compiler plugin then emits empty chunks and the build fails (\`"default" is not exported\`). Remove it there and typecheck with a separate tsconfig.`,
        );
      return pass(`${rel(ctx.root, file)} lets the Angular compiler emit.`);
    },
  },
  {
    id: 'analog.server-providers',
    title: 'Angular server config provides the Hypdriv request context',
    category: 'nitro',
    severity: 'info',
    frameworks: ['analog'],
    run(ctx) {
      const file = join(ctx.root, 'src', 'app', 'app.config.server.ts');
      if (!existsSync(file)) return skip('no src/app/app.config.server.ts (SSR off, or a custom layout).');
      const source = readFileSync(file, 'utf8');
      if (/provideHypDriv\s*\(/.test(source))
        return pass('provideHypDriv() hands the request context and CSP nonce to Angular.');
      return info(
        "provideHypDriv() (from '@hypdriv/analog/angular/server') is not in app.config.server.ts: Angular tags carry no CSP nonce and components cannot call injectHyp(). Required only for nonce-based style/script policies or per-request components.",
      );
    },
  },
];
