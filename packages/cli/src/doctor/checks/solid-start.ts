import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rel } from '../../util/fs';
import { type Check, fail, info, pass, skip, warn } from '../types';

/** SolidStart's server entry (the module whose default export is `createHandler(…)`). */
export const SOLID_START_SERVER_ENTRIES = ['tsx', 'jsx', 'ts', 'js'].map((ext) => `src/entry-server.${ext}`);

/** The source without line and block comments (a commented-out plugin is not registered). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

export interface SolidStartPlugins {
  /** Where each plugin call first appears in the config (`-1` when absent). */
  solidStart: number;
  nitro: number;
  cloudflare: number;
  hypdriv: number;
}

/** Positions of the plugins SolidStart 2 projects list in `vite.config` (`solidStart()`, a deployment plugin, `hypdriv()`). */
export function solidStartPlugins(config: string): SolidStartPlugins {
  const code = withoutComments(config);
  const at = (callee: string) => code.search(new RegExp(`(^|[^\\w$.])${callee}\\s*\\(`));
  return {
    solidStart: at('solidStart'),
    nitro: at('nitro'),
    cloudflare: at('cloudflare'),
    hypdriv: at('hypdriv'),
  };
}

/**
 * The deployment plugin SolidStart 2 builds with: Nitro (`nitro/vite`: Node, Vercel, Netlify, a Nitro-built Worker) or
 * `@cloudflare/vite-plugin`. `none` leaves `vite build` without a deployable server.
 */
export function solidStartDeployment(config: string): 'nitro' | 'cloudflare' | 'both' | 'none' {
  const plugins = solidStartPlugins(config);
  const nitro = plugins.nitro !== -1;
  const cloudflare = plugins.cloudflare !== -1 && /@cloudflare\/vite-plugin/.test(config);
  return nitro && cloudflare ? 'both' : nitro ? 'nitro' : cloudflare ? 'cloudflare' : 'none';
}

/**
 * Whether `hypdriv()` is listed after `solidStart()` and the deployment plugin, as it must be: it finalises the
 * manifest once Nitro has built and prerendered.
 */
export function solidStartPluginOrder(
  config: string,
): 'ok' | 'unregistered' | 'before-solid-start' | 'before-deployment' {
  const plugins = solidStartPlugins(config);
  if (plugins.hypdriv === -1) return 'unregistered';
  if (plugins.solidStart !== -1 && plugins.hypdriv < plugins.solidStart) return 'before-solid-start';
  if ([plugins.nitro, plugins.cloudflare].some((at) => at !== -1 && plugins.hypdriv < at))
    return 'before-deployment';
  return 'ok';
}

/** Whether `@cloudflare/vite-plugin` runs SolidStart's server environment (`ssr`). */
export function solidStartCloudflareEnvironment(config: string): 'ok' | 'missing' | 'environment' {
  const code = withoutComments(config);
  if (!/@cloudflare\/vite-plugin/.test(code) || !/(^|[^\w$.])cloudflare\s*\(/.test(code)) return 'missing';
  return /viteEnvironment\s*:\s*\{[^}]*\bname\s*:\s*['"]ssr['"]/.test(code) ? 'ok' : 'environment';
}

/** The major version of `@solidjs/start` from an installed or declared version (`2.1.0`, `^2.0.0`). */
export function solidStartMajor(version: string | null | undefined): number | null {
  const match = /(\d+)\./.exec(version ?? '');
  return match ? Number(match[1]) : null;
}

/** How a Worker entry file relates to the Hypdriv shell: it should wrap SolidStart, not be SolidStart's entry. */
export function solidStartWorkerEntry(source: string): 'shell' | 'solid-entry' | 'other' {
  if (/createSolidStartWorker|createWorker\s*\(/.test(source)) return 'shell';
  if (/createHandler\s*\(/.test(source) && /@solidjs\/start\/server/.test(source)) return 'solid-entry';
  return 'other';
}

function serverEntry(root: string): { file: string; source: string } | null {
  for (const candidate of SOLID_START_SERVER_ENTRIES) {
    const file = join(root, candidate);
    if (existsSync(file)) return { file, source: readFileSync(file, 'utf8') };
  }
  return null;
}

export const solidStartChecks: Check[] = [
  {
    id: 'solid-start.version',
    title: 'Supported SolidStart version',
    category: 'solid-start',
    severity: 'warn',
    frameworks: ['solid-start'],
    run(ctx) {
      const version = ctx.project.framework.version;
      const major = solidStartMajor(version);
      if (!version || major === null) return skip('SolidStart version unknown.');
      if (major < 2)
        return warn(
          `SolidStart ${version} configures through Vinxi (app.config.ts); @hypdriv/solid-start supports SolidStart 2 (>=2.0.0 <3), which builds with Vite and deployment plugins. Upgrade, then run \`hypdriv init\` again.`,
        );
      if (major > 2)
        return warn(
          `SolidStart ${version} is outside @hypdriv/solid-start's range (>=2.0.0 <3): the Nitro and entry APIs Hypdriv wraps may differ.`,
        );
      return pass(`SolidStart ${version}.`);
    },
  },
  {
    id: 'solid-start.deployment-plugin',
    title: 'Deployment plugin (Nitro or @cloudflare/vite-plugin)',
    category: 'solid-start',
    severity: 'error',
    frameworks: ['solid-start'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      if (!file || !/vite\.config\./.test(file)) return skip('no vite.config found.');
      const verdict = solidStartDeployment(readFileSync(file, 'utf8'));
      if (verdict === 'none')
        return fail(
          `${rel(ctx.root, file)} registers no deployment plugin, so \`vite build\` writes no deployable server: add \`nitro()\` from 'nitro/vite' (Node, Vercel) or \`cloudflare({ viteEnvironment: { name: 'ssr' } })\` from '@cloudflare/vite-plugin' (Workers).`,
        );
      if (verdict === 'both')
        return warn(
          `${rel(ctx.root, file)} registers both nitro() and cloudflare(); SolidStart builds with one deployment plugin per target (select it with HYPDRIV_TARGET or similar).`,
        );
      return pass(
        `${rel(ctx.root, file)} registers ${verdict === 'nitro' ? 'nitro()' : '@cloudflare/vite-plugin'}.`,
      );
    },
  },
  {
    id: 'solid-start.plugin-order',
    title: 'hypdriv() after solidStart() and the deployment plugin',
    category: 'solid-start',
    severity: 'error',
    frameworks: ['solid-start'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      if (!file || !/vite\.config\./.test(file)) return skip('no vite.config found.');
      const verdict = solidStartPluginOrder(readFileSync(file, 'utf8'));
      if (verdict === 'ok') return pass(`${rel(ctx.root, file)} lists hypdriv() after the other plugins.`);
      if (verdict === 'unregistered') return skip('hypdriv() is not registered (see vite.registered).');
      return fail(
        `${rel(ctx.root, file)} lists hypdriv() before ${verdict === 'before-solid-start' ? 'solidStart()' : 'the deployment plugin'}: it finalises the manifest once Nitro has built and prerendered, so it must come last.`,
      );
    },
  },
  {
    id: 'solid-start.cloudflare-plugin',
    title: '@cloudflare/vite-plugin on SolidStart’s ssr environment',
    category: 'solid-start',
    severity: 'error',
    frameworks: ['solid-start'],
    platforms: ['cloudflare'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      if (!file || !/vite\.config\./.test(file)) return skip('no vite.config found.');
      const source = readFileSync(file, 'utf8');
      if (solidStartPlugins(source).nitro !== -1 && !/@cloudflare\/vite-plugin/.test(source))
        return info(
          "nitro() builds the Worker (Nitro's cloudflare_module preset): add nodejs_compat to its wrangler configuration and keep `main`/assets as Nitro writes them in .output/server/wrangler.json.",
        );
      const verdict = solidStartCloudflareEnvironment(source);
      if (verdict === 'ok')
        return pass(`${rel(ctx.root, file)} registers cloudflare() for the ssr environment.`);
      if (verdict === 'environment')
        return fail(
          `${rel(ctx.root, file)} registers cloudflare() without \`viteEnvironment: { name: 'ssr' }\`: SolidStart renders in the ssr environment.`,
        );
      return fail(
        `${rel(ctx.root, file)} does not register @cloudflare/vite-plugin; add \`cloudflare({ viteEnvironment: { name: 'ssr' } })\` after solidStart().`,
      );
    },
  },
  {
    id: 'solid-start.worker-entry',
    title: 'Worker main wraps SolidStart in the Hypdriv shell',
    category: 'solid-start',
    severity: 'error',
    frameworks: ['solid-start'],
    platforms: ['cloudflare'],
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      const config = ctx.project.framework.configFile;
      if (!cfg) return skip('no wrangler config.');
      if (
        config &&
        /vite\.config\./.test(config) &&
        !/@cloudflare\/vite-plugin/.test(readFileSync(config, 'utf8'))
      )
        return skip(
          'the Worker is built by Nitro (no @cloudflare/vite-plugin), whose runtime plugin runs the pipeline.',
        );
      if (!cfg.main)
        return fail(
          'wrangler has no `main`; point it at a Worker entry that exports createSolidStartWorker() (src/worker.ts) and the Hypdriv Durable Objects.',
        );
      const file = join(ctx.root, cfg.main);
      if (!existsSync(file)) return warn(`wrangler main ${cfg.main} does not exist.`);
      const verdict = solidStartWorkerEntry(readFileSync(file, 'utf8'));
      if (verdict === 'shell') return pass(`${cfg.main} wraps SolidStart in the Hypdriv shell.`);
      if (verdict === 'solid-entry')
        return fail(
          `${cfg.main} is SolidStart's server entry; the Worker's main must be your own file exporting \`createSolidStartWorker({ config, manifest, entry: () => import('./entry-server') })\` so the pipeline, scheduled jobs and Durable Objects run.`,
        );
      return warn(
        `${cfg.main} does not use createSolidStartWorker() from '@hypdriv/solid-start/cloudflare'; the Hypdriv pipeline only runs through it.`,
      );
    },
  },
  {
    id: 'solid-start.entry-nonce',
    title: 'Solid renders the request nonce',
    category: 'solid-start',
    severity: 'info',
    frameworks: ['solid-start'],
    run(ctx) {
      const entry = serverEntry(ctx.root);
      if (!entry) return skip('no src/entry-server found.');
      if (/\bhypdrivStart\s*\(/.test(withoutComments(entry.source)))
        return pass(`${rel(ctx.root, entry.file)} passes hypdrivStart() to createHandler().`);
      return info(
        `${rel(ctx.root, entry.file)} does not pass hypdrivStart() to createHandler(): the CSP stage still nonces the streamed HTML (a rewrite of the response); with it Solid renders the nonce itself (\`createHandler(fn, hypdrivStart())\`, import from '@hypdriv/solid-start').`,
      );
    },
  },
  {
    id: 'solid-start.prerender',
    title: 'Pages prerendered through Nitro',
    category: 'solid-start',
    severity: 'info',
    frameworks: ['solid-start'],
    platforms: ['vercel', 'node'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      if (!file || !/vite\.config\./.test(file)) return skip('no vite.config found.');
      if (/\bprerender\s*:/.test(withoutComments(readFileSync(file, 'utf8'))))
        return pass(`${rel(ctx.root, file)} configures Nitro prerendering.`);
      return info(
        'SolidStart prerenders only through Nitro: without `nitro: { prerender: { routes: [...] } }` in vite.config every page renders per request (nonce-based CSP). List marketing and documentation pages to serve them as static files with a hash-based CSP.',
      );
    },
  },
];
