import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rel } from '../../util/fs';
import { type Check, fail, info, pass, skip, warn } from '../types';

/** Where RedwoodSDK's starter keeps the Worker (the Wrangler config's `main`). */
export const RWSDK_WORKER_ENTRIES = ['tsx', 'ts', 'jsx', 'js'].map((ext) => `src/worker.${ext}`);

/** The file that exports the Worker: the Wrangler config's `main`, else `src/worker.*`. */
export function rwsdkWorkerEntry(
  root: string,
  main: string | undefined,
  configDir: string,
): { file: string; source: string } | null {
  const candidates = [
    ...(main ? [join(configDir, main)] : []),
    ...RWSDK_WORKER_ENTRIES.map((c) => join(root, c)),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      return { file, source: readFileSync(file, 'utf8') };
    } catch {
      // unreadable: try the next candidate
    }
  }
  return null;
}

/** What the Worker entry does with Hypdriv: wraps the app in `withHypDriv()`, and registers the nonce middleware. */
export function rwsdkWorkerWiring(source: string): { wrapped: boolean; middleware: boolean } {
  return {
    wrapped: /\bwithHypDriv\s*\(/.test(source) && /@hypdriv\/rwsdk\/worker/.test(source),
    middleware: /\bhypdrivMiddleware\s*\(/.test(source),
  };
}

/** The source file under `src/` that calls `hypdrivMiddleware()` (the routes may live outside the Worker entry). */
export function findMiddleware(root: string): string | null {
  const visit = (dir: string, depth: number, budget: { left: number }): string | null => {
    if (depth > 6) return null;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of names.sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (/\.[cm]?[jt]sx?$/.test(name)) {
        if (budget.left-- <= 0) return null;
        try {
          if (/\bhypdrivMiddleware\s*\(/.test(readFileSync(path, 'utf8'))) return path;
        } catch {
          // unreadable: ignore
        }
      } else if (!name.includes('.')) {
        const found = visit(path, depth + 1, budget);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(join(root, 'src'), 0, { left: 500 });
}

/**
 * How `vite.config` registers `@cloudflare/vite-plugin`. RedwoodSDK adds the plugin itself when the config does not
 * (`implicit`); a config that declares it must name the `worker` environment and declare `environments: { ssr: {} }`.
 */
export function rwsdkCloudflarePlugin(config: string): 'ok' | 'implicit' | 'environment' | 'ssr-environment' {
  if (!/@cloudflare\/vite-plugin/.test(config) || !/\bcloudflare\s*\(/.test(config)) return 'implicit';
  if (!/viteEnvironment\s*:\s*\{[^}]*\bname\s*:\s*['"]worker['"]/.test(config)) return 'environment';
  return /\benvironments\s*:\s*\{[^}]*\bssr\s*:/.test(config) ? 'ok' : 'ssr-environment';
}

/** Whether `hypdriv()` is listed after `redwood()` in the config (it finalises what RedwoodSDK's build wrote). */
export function rwsdkPluginOrder(config: string): 'ok' | 'before' | 'unknown' {
  const redwood = config.search(/\bredwood\s*\(/);
  const hypdriv = config.search(/\bhypdriv\s*\(/);
  if (redwood < 0 || hypdriv < 0) return 'unknown';
  return hypdriv > redwood ? 'ok' : 'before';
}

/** Whether a RedwoodSDK version is one this Hypdriv release supports (`>=1.0.0 <2`). */
export function rwsdkVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version);
  if (!match) return true;
  if (Number(match[1]) !== 1) return false;
  // Pre-releases of 1.0.0 predate the Vite-based request pipeline Hypdriv wraps.
  return !(match[4] && Number(match[2]) === 0 && Number(match[3]) === 0);
}

export const rwsdkChecks: Check[] = [
  {
    id: 'rwsdk.worker-entry',
    title: 'Worker entry wrapped in withHypDriv()',
    category: 'rwsdk',
    severity: 'error',
    frameworks: ['rwsdk'],
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      const configDir =
        cfg?.main && ctx.project.wrangler.configFile ? dirname(ctx.project.wrangler.configFile) : ctx.root;
      const entry = rwsdkWorkerEntry(ctx.root, cfg?.main, configDir);
      if (!entry) return skip('no Worker entry found (wrangler `main`, or src/worker.tsx).');
      const { wrapped } = rwsdkWorkerWiring(entry.source);
      if (wrapped) return pass(`${rel(ctx.root, entry.file)} exports the app wrapped in withHypDriv().`);
      return fail(
        `${rel(ctx.root, entry.file)} does not wrap the app in withHypDriv(), so the Drivetrain never runs: \`import { withHypDriv } from '@hypdriv/rwsdk/worker'\` and \`export default withHypDriv(defineApp([...]))\`.`,
      );
    },
  },
  {
    id: 'rwsdk.nonce-middleware',
    title: 'hypdrivMiddleware() hands RedwoodSDK the CSP nonce',
    category: 'rwsdk',
    severity: 'error',
    frameworks: ['rwsdk'],
    run(ctx) {
      const csp = ctx.config.resolved.security.csp;
      if (!csp || csp.mode === 'off') return skip('CSP is off; RedwoodSDK’s own nonce is not blocked.');
      const cfg = ctx.project.wrangler.config;
      const configDir =
        cfg?.main && ctx.project.wrangler.configFile ? dirname(ctx.project.wrangler.configFile) : ctx.root;
      const entry = rwsdkWorkerEntry(ctx.root, cfg?.main, configDir);
      if (!entry) return skip('no Worker entry found.');
      if (rwsdkWorkerWiring(entry.source).middleware)
        return pass(`${rel(ctx.root, entry.file)} registers hypdrivMiddleware().`);
      const elsewhere = findMiddleware(ctx.root);
      if (elsewhere) return pass(`${rel(ctx.root, elsewhere)} registers hypdrivMiddleware().`);
      return fail(
        `No hypdrivMiddleware() in the routes: RedwoodSDK renders its RSC payload and hydration scripts with its own nonce, which the nonce CSP does not allow, so the browser blocks them. Put \`hypdrivMiddleware()\` (from '@hypdriv/rwsdk/worker') first in defineApp([...]).`,
      );
    },
  },
  {
    id: 'rwsdk.cloudflare-plugin',
    title: '@cloudflare/vite-plugin on RedwoodSDK’s worker environment',
    category: 'rwsdk',
    severity: 'error',
    frameworks: ['rwsdk'],
    platforms: ['cloudflare'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      if (!file) return skip('no vite.config found.');
      const verdict = rwsdkCloudflarePlugin(readFileSync(file, 'utf8'));
      if (verdict === 'ok')
        return pass(`${rel(ctx.root, file)} registers cloudflare() for the worker environment.`);
      if (verdict === 'implicit')
        return info(
          `${rel(ctx.root, file)} does not register @cloudflare/vite-plugin; RedwoodSDK adds it with the worker environment.`,
        );
      if (verdict === 'environment')
        return fail(
          `${rel(ctx.root, file)} registers cloudflare() without \`viteEnvironment: { name: 'worker' }\`: RedwoodSDK builds the Worker in the worker environment, which Hypdriv finalises.`,
        );
      return fail(
        `${rel(ctx.root, file)} registers cloudflare() but not \`environments: { ssr: {} }\`; RedwoodSDK needs it next to the declared plugin.`,
      );
    },
  },
  {
    id: 'rwsdk.plugin-order',
    title: 'hypdriv() after redwood()',
    category: 'rwsdk',
    severity: 'warn',
    frameworks: ['rwsdk'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      if (!file) return skip('no vite.config found.');
      const order = rwsdkPluginOrder(readFileSync(file, 'utf8'));
      if (order === 'unknown') return skip('hypdriv() or redwood() is not called in the config.');
      if (order === 'before')
        return warn(
          `${rel(ctx.root, file)} lists hypdriv() before redwood(); put hypdriv() last so it finalises the manifest after RedwoodSDK's multi-pass build.`,
        );
      return pass(`${rel(ctx.root, file)} lists hypdriv() after redwood().`);
    },
  },
  {
    id: 'rwsdk.platform',
    title: 'RedwoodSDK deploys to Cloudflare Workers',
    category: 'rwsdk',
    severity: 'warn',
    frameworks: ['rwsdk'],
    run(ctx) {
      const platform = ctx.project.platform;
      if (platform === 'cloudflare') return pass('Cloudflare Workers.');
      if (platform === 'vercel' || (platform === 'node' && ctx.project.platformDetection.explicit))
        return warn(
          `The project targets ${platform}, but RedwoodSDK builds a Cloudflare Worker (and @hypdriv/rwsdk wraps it): deploy it to Workers with \`wrangler deploy\`.`,
        );
      return skip('no deployment platform detected (add a wrangler config).');
    },
  },
  {
    id: 'rwsdk.version',
    title: 'Supported RedwoodSDK version',
    category: 'rwsdk',
    severity: 'warn',
    frameworks: ['rwsdk'],
    run(ctx) {
      const version = ctx.project.framework.version;
      if (!version) return skip('RedwoodSDK version unknown.');
      if (!rwsdkVersionSupported(version))
        return warn(
          `RedwoodSDK ${version} is outside @hypdriv/rwsdk's range (>=1.0.0 <2): the route table and request info Hypdriv reads may differ.`,
        );
      return pass(`RedwoodSDK ${version}.`);
    },
  },
];
