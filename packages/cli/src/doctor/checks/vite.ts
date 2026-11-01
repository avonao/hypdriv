import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { manifestFramework } from '@hypdriv/core';
import { FRAMEWORK_LABEL, type ProjectFramework } from '../../project';
import { rel } from '../../util/fs';
import { type Check, fail, info, pass, skip, warn } from '../types';
import { HYPDRIV_DO_CLASSES } from './wrangler';

/** Vite-based hosts (everything Hypdriv supports besides Next.js). */
export const VITE_HOSTS: ProjectFramework[] = [
  'vite',
  'react-router',
  'tanstack-start',
  'astro',
  'sveltekit',
  'nuxt',
  'vinext',
  'waku',
  'nitro',
  'analog',
];

/** Where each host registers Hypdriv, for messages. */
const REGISTRATION: Partial<Record<ProjectFramework, string>> = {
  vite: "plugins: [hypdriv()] in vite.config.ts (import { hypdriv } from '@hypdriv/vite')",
  'react-router':
    "the Hypdriv preset in react-router.config.ts and its Vite plugin (import from '@hypdriv/react-router')",
  'tanstack-start': "the Hypdriv Vite plugin in vite.config.ts (import from '@hypdriv/tanstack-start')",
  astro: "integrations: [hypdriv()] in astro.config.mjs (import hypdriv from '@hypdriv/astro')",
  sveltekit:
    "the Hypdriv adapter wrapper and Vite plugin in vite.config.ts (import from '@hypdriv/sveltekit')",
  nuxt: "modules: ['@hypdriv/nuxt'] in nuxt.config.ts",
  vinext: "the Hypdriv Vite plugin next to vinext() in vite.config.ts (import from '@hypdriv/vinext')",
  waku: "withHypDriv() around the config in waku.config.ts (import { withHypDriv } from '@hypdriv/waku')",
  nitro:
    "hypdrivNitro() in modules of nitro.config.ts (Nitro 2), or hypdriv() from '@hypdriv/nitro/vite' next to nitro() in vite.config.ts (Nitro 3)",
  analog:
    "withHypDriv() around the analog() options and hypdriv() in vite.config.ts (import from '@hypdriv/analog' and '@hypdriv/vite')",
};

/** Build output directories the static configuration of each platform is written to. */
function builtHeaders(root: string): string[] {
  const candidates = [
    'dist/client/_headers',
    'dist/public/_headers',
    'dist/_headers',
    'build/client/_headers',
    '.output/public/_headers',
    'dist/analog/public/_headers',
    '.svelte-kit/cloudflare/_headers',
  ];
  return candidates.map((c) => join(root, c)).filter((f) => existsSync(f));
}

/** The Worker entry a framework build generated with its own wrangler config (`.output/server/wrangler.json`, Analog's `dist/analog/server/wrangler.json`). */
function generatedWorkerEntry(root: string): string | null {
  for (const config of [
    '.output/server/wrangler.json',
    'dist/server/wrangler.json',
    'dist/analog/server/wrangler.json',
  ]) {
    const file = join(root, config);
    if (!existsSync(file)) continue;
    try {
      const main = (JSON.parse(readFileSync(file, 'utf8')) as { main?: string }).main;
      if (main) return join(file, '..', main);
    } catch {
      // unreadable: fall through
    }
  }
  return null;
}

export const viteChecks: Check[] = [
  {
    id: 'vite.integration',
    title: 'Hypdriv integration package',
    category: 'vite',
    severity: 'error',
    frameworks: VITE_HOSTS,
    run(ctx) {
      const f = ctx.project.framework;
      if (!f.integration) return skip('no framework detected.');
      if (!f.integrationInstalled)
        return fail(
          `${FRAMEWORK_LABEL[f.name]} ${f.version ?? ''} detected but ${f.integration} is not installed (pnpm add ${f.integration}).`,
        );
      return pass(
        `${f.integration}@${f.integrationInstalled} for ${FRAMEWORK_LABEL[f.name]} ${f.version ?? ''}`.trim(),
      );
    },
  },
  {
    id: 'vite.registered',
    title: 'Integration registered in the framework config',
    category: 'vite',
    severity: 'error',
    frameworks: VITE_HOSTS,
    run(ctx) {
      const f = ctx.project.framework;
      if (!f.configFile)
        return warn(`No config file found; register ${REGISTRATION[f.name] ?? f.integration}.`);
      if (f.registered) return pass(`${rel(ctx.root, f.configFile)} references ${f.integration}.`);
      return fail(
        `${rel(ctx.root, f.configFile)} does not reference ${f.integration}; add ${REGISTRATION[f.name]}.`,
      );
    },
  },
  {
    id: 'vite.manifest-framework',
    title: 'Manifest built by the detected framework',
    category: 'vite',
    severity: 'warn',
    frameworks: VITE_HOSTS,
    run(ctx) {
      if (!ctx.manifest) return skip('no build manifest yet (run the production build).');
      const built = manifestFramework(ctx.manifest);
      const detected = ctx.project.framework.name;
      if (!built) return warn('The manifest does not record a framework; rebuild with the current Hypdriv.');
      if (built.name !== detected)
        return warn(
          `The manifest was built by ${FRAMEWORK_LABEL[built.name]}, the project is ${FRAMEWORK_LABEL[detected]}; rebuild.`,
        );
      const routes = ctx.manifest.routes.filter((r) => r.kind !== 'static-file');
      const prerendered = routes.filter((r) => r.classification === 'static' || r.classification === 'isr');
      return pass(
        `${FRAMEWORK_LABEL[built.name]} ${built.version}: ${routes.length} route(s), ${prerendered.length} prerendered, ${Object.keys(ctx.manifest.csp).length} hashed document(s).`,
      );
    },
  },
  {
    id: 'vite.static-headers',
    title: 'Static header rules in the build output',
    category: 'vite',
    severity: 'warn',
    frameworks: VITE_HOSTS,
    platforms: ['cloudflare'],
    run(ctx) {
      const files = builtHeaders(ctx.root);
      if (!files.length) return skip('no Cloudflare build output with a _headers file yet.');
      const missing = files.filter((f) => !readFileSync(f, 'utf8').includes('# hypdriv:start'));
      if (missing.length)
        return warn(
          `${missing.map((f) => rel(ctx.root, f)).join(', ')} has no Hypdriv block: prerendered pages ship without Hypdriv's CSP and security headers. Is the integration registered?`,
        );
      const ignored = files.every((f) => {
        const ignore = join(f, '..', '.assetsignore');
        return existsSync(ignore) && /^\.vite$/m.test(readFileSync(ignore, 'utf8'));
      });
      if (!ignored)
        return warn(
          'The assets directory does not ignore .vite/ (build metadata would be uploaded as public files).',
        );
      return pass(`${files.map((f) => rel(ctx.root, f)).join(', ')} carries Hypdriv's rules.`);
    },
  },
  {
    id: 'vite.worker-first',
    title: 'Navigations reach the Worker',
    category: 'vite',
    severity: 'info',
    frameworks: VITE_HOSTS,
    platforms: ['cloudflare'],
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      const rwf = cfg.assets?.run_worker_first;
      if (rwf === true || (Array.isArray(rwf) && rwf.length))
        return pass(
          rwf === true
            ? 'run_worker_first: every request runs the pipeline.'
            : `run_worker_first for ${rwf.length} pattern(s): prerendered pages get the full pipeline.`,
        );
      return info(
        'Static and prerendered pages are served before the Worker: they get Hypdriv\'s static header rules (_headers) but not the request stages (rate limiting, bot shield, maintenance, geo, flags). Set assets.run_worker_first (e.g. ["/*", "!/assets/*"]) to run them.',
      );
    },
  },
  {
    id: 'vite.durable-objects',
    title: 'Hypdriv Durable Objects exported',
    category: 'vite',
    severity: 'warn',
    frameworks: VITE_HOSTS,
    platforms: ['cloudflare'],
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      const bound = cfg.durable_objects.bindings.filter((d) =>
        HYPDRIV_DO_CLASSES.includes(d.class_name ?? ''),
      );
      if (!bound.length) return skip('no Hypdriv Durable Object bindings (optional upgrades).');
      let main = cfg.main;
      if (!main) {
        // Frameworks whose build generates the Worker and its config (Nuxt/Nitro `cloudflare-module`).
        const generated = generatedWorkerEntry(ctx.root);
        if (generated) main = rel(ctx.root, generated);
        else if (['nuxt', 'nitro', 'analog'].includes(ctx.project.framework.name))
          return info(
            `The Worker entry is generated at build time (${ctx.project.framework.integration} with Nitro's cloudflare-module preset); build once to check its exports.`,
          );
        else return warn('Durable Objects are bound but the Worker has no `main` that could export them.');
      }
      // `main` is relative to the wrangler config (which may live in a subdirectory, e.g. vinext's `cloudflare/`).
      const configDir =
        cfg.main && ctx.project.wrangler.configFile ? dirname(ctx.project.wrangler.configFile) : ctx.root;
      const entry = join(configDir, main);
      if (!existsSync(entry) && ctx.project.framework.name === 'waku')
        return pass(
          `${bound.length} Hypdriv Durable Object(s) bound; Waku's managed server entry has no file (${main}) and @hypdriv/waku exports the classes from the Worker.`,
        );
      if (!existsSync(entry))
        return info(
          `main ${main} is generated at build time; make sure it exports ${bound.map((b) => b.class_name).join(', ')}.`,
        );
      const source = readFileSync(entry, 'utf8');
      const missing = bound.filter(
        (b) => !source.includes(b.class_name ?? '') && !/durable-objects/.test(source),
      );
      if (missing.length)
        return fail(
          `${main} does not export ${missing.map((m) => m.class_name).join(', ')}; add \`export { HypDrivChannel, HypDrivLimiter, HypDrivIndex } from '@hypdriv/cloudflare/durable-objects'\`.`,
        );
      return pass(`${bound.length} Hypdriv Durable Object(s) bound and exported from ${main}.`);
    },
  },
  {
    id: 'vite.vercel-output',
    title: 'Hypdriv routes in the Vercel Build Output',
    category: 'vite',
    severity: 'warn',
    frameworks: VITE_HOSTS,
    platforms: ['vercel'],
    run(ctx) {
      const file = join(ctx.project.vercel.outputDir ?? join(ctx.root, '.vercel', 'output'), 'config.json');
      if (!existsSync(file))
        return skip('no .vercel/output yet (run the build with VERCEL=1 or `vercel build`).');
      const config = JSON.parse(readFileSync(file, 'utf8')) as {
        routes?: Array<{ headers?: Record<string, string> }>;
      };
      const own = (config.routes ?? []).filter((r) => r.headers?.['x-hypdriv-static'] !== undefined).length;
      if (!own)
        return warn(
          ".vercel/output/config.json has no Hypdriv header routes: prerendered pages ship without Hypdriv's CSP and security headers.",
        );
      const functions = join(file, '..', 'functions');
      const staticDir = join(file, '..', 'static');
      const leaked = existsSync(join(staticDir, '.vite'));
      if (leaked) return warn('.vercel/output/static/.vite exists: build metadata would be served publicly.');
      const count = existsSync(functions) ? readdirSync(functions).length : 0;
      return pass(`${own} Hypdriv header route(s); ${count} function entr${count === 1 ? 'y' : 'ies'}.`);
    },
  },
];
