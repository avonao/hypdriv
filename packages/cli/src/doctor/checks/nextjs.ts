import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atLeast } from '../../semver';
import { rel } from '../../util/fs';
import { type Check, fail, info, pass, skip, warn } from '../types';

export const MIN_NEXT = '16.0.0';
export const ADAPTER_API_NEXT = '16.2.0';
export const MIN_REACT = '19.2.0';

export const nextjsChecks: Check[] = [
  {
    id: 'next.installed',
    title: 'Next.js installed',
    category: 'nextjs',
    severity: 'error',
    run(ctx) {
      const next = ctx.project.next;
      if (!next.installed)
        return fail(
          next.range
            ? `next ${next.range} is declared but not installed; run the package manager install.`
            : 'next is not installed in this project.',
        );
      return pass(`next ${next.installed}`);
    },
  },
  {
    id: 'next.version',
    title: 'Next.js version',
    category: 'nextjs',
    severity: 'error',
    run(ctx) {
      const v = ctx.project.next.installed;
      if (!v) return skip('next is not installed.');
      if (!atLeast(v, MIN_NEXT))
        return fail(`next ${v} is not supported; HypDriv targets Next.js ${MIN_NEXT}+.`);
      if (!atLeast(v, ADAPTER_API_NEXT))
        return warn(
          `next ${v}: the stable Adapter API (adapterPath, onBuildComplete) arrived in ${ADAPTER_API_NEXT}; without it no .hypdriv/manifest.json is produced.`,
        );
      return pass(`next ${v}`);
    },
  },
  {
    id: 'next.react-version',
    title: 'React version',
    category: 'nextjs',
    severity: 'warn',
    run(ctx) {
      const v = ctx.project.react.installed;
      if (!v) return skip('react is not installed.');
      if (!atLeast(v, MIN_REACT))
        return warn(
          `react ${v}; Next.js 16 features HypDriv relies on (View Transitions, useEffectEvent, Activity) need React ${MIN_REACT}+.`,
        );
      return pass(`react ${v}`);
    },
  },
  {
    id: 'next.config-file',
    title: 'next.config present',
    category: 'nextjs',
    severity: 'warn',
    run(ctx) {
      const nc = ctx.project.nextConfig;
      if (!nc)
        return warn(
          'No next.config.(ts|mjs|js) found; `hypdriv init` creates one wrapped in withHypDriv().',
          { fix: { description: 'run `hypdriv init`' } },
        );
      return pass(`${rel(ctx.root, nc.file)} (${nc.module})`);
    },
  },
  {
    id: 'next.with-hypdriv',
    title: 'next.config wrapped in withHypDriv()',
    category: 'nextjs',
    severity: 'error',
    run(ctx) {
      const nc = ctx.project.nextConfig;
      if (!nc) return skip('no next.config file.');
      if (nc.wrapped) return pass('withHypDriv() wraps the exported config.');
      if (nc.importsWithHypDriv)
        return warn(
          'withHypDriv is imported but the default export is not wrapped (`export default withHypDriv(nextConfig)`).',
        );
      return fail(
        'next.config does not use withHypDriv(); the adapter chain and safe defaults are inactive.',
        { fix: { description: 'run `hypdriv init` (wraps the default export and backs the file up)' } },
      );
    },
  },
  {
    id: 'next.adapter-path',
    title: 'Existing adapterPath',
    category: 'nextjs',
    severity: 'info',
    run(ctx) {
      const nc = ctx.project.nextConfig;
      if (!nc) return skip('no next.config file.');
      if (nc.adapterPath)
        return info(
          `adapterPath "${nc.adapterPath}" is set; withHypDriv() chains it as the base adapter and runs its own hooks after it.`,
        );
      return pass('No application adapter; HypDriv is the only adapter.');
    },
  },
  {
    id: 'next.middleware-deprecated',
    title: 'Deprecated middleware.ts',
    category: 'nextjs',
    severity: 'warn',
    run(ctx) {
      const mw = ctx.project.middlewareFile;
      const proxy = ctx.project.proxyFile;
      if (!mw) return pass('No middleware.ts (proxy.ts is the Next.js 16 convention).');
      if (proxy)
        return warn(
          `${rel(ctx.root, mw)} and ${rel(ctx.root, proxy)} both exist; Next.js 16 uses proxy.ts and ignores middleware.ts in a conflicting setup. Remove middleware.ts.`,
        );
      return warn(
        `${rel(ctx.root, mw)} is deprecated in Next.js 16; rename it to proxy.ts (npx @next/codemod@canary middleware-to-proxy .) and compose it with createProxy().`,
      );
    },
  },
  {
    id: 'next.proxy',
    title: 'proxy.ts',
    category: 'nextjs',
    severity: 'info',
    run(ctx) {
      const proxy = ctx.project.proxyFile;
      if (!proxy)
        return info(
          'No proxy.ts: HypDriv stages run only inside the Worker. `hypdriv init` writes one so `next dev` and `next start` get the same headers.',
        );
      const source = readFileSync(proxy, 'utf8');
      if (/createProxy\s*\(/.test(source)) return pass(`${rel(ctx.root, proxy)} uses createProxy().`);
      return warn(
        `${rel(ctx.root, proxy)} exists but does not use createProxy(); compose it so development gets the HypDriv stages (see \`hypdriv init\`).`,
      );
    },
  },
  {
    id: 'next.proxy-config',
    title: 'proxy.ts config is a literal object',
    category: 'nextjs',
    severity: 'error',
    run(ctx) {
      const proxy = ctx.project.proxyFile;
      if (!proxy) return skip('no proxy.ts.');
      const source = readFileSync(proxy, 'utf8');
      const file = rel(ctx.root, proxy);
      const fix = {
        description:
          "replace the config export with a literal: export const config = { matcher: ['/((?!_next/static|_next/image|favicon\\\\.ico).*)', '/_hypdriv/:path*'] }",
      };
      if (
        /export\s*\{[^}]*\bmatcher\s+as\s+config\b[^}]*\}/.test(source) ||
        /export\s*\{[^}]*\bconfig\b[^}]*\}\s*from/.test(source)
      ) {
        return fail(
          `${file} re-exports \`config\`; Next.js reads it statically and rejects re-exports ("Next.js can't recognize the exported config field").`,
          { fix },
        );
      }
      const decl = /export\s+const\s+config\s*(?::[^=]+)?=\s*([\s\S]{0,40})/.exec(source);
      if (!decl) return pass(`${file} exports no config (the proxy runs for every request).`);
      if (!decl[1]!.trimStart().startsWith('{'))
        return fail(
          `${file} assigns \`config\` from an expression; it must be an object literal so Next.js can read the matcher statically.`,
          { fix },
        );
      return pass(`${file} exports a literal config.`);
    },
  },
  {
    id: 'next.edge-runtime',
    title: 'Edge runtime segments',
    category: 'nextjs',
    severity: 'error',
    run(ctx) {
      const findings = ctx.project.sources.edgeRuntime;
      if (!findings.length) return pass('No `export const runtime = "edge"` segments.');
      const details = findings.map((f) => `${f.file}:${f.line}  ${f.snippet}`);
      if (ctx.project.platform === 'cloudflare') {
        return fail(
          `${findings.length} file(s) opt into the deprecated Edge runtime, which OpenNext Cloudflare does not support. Remove the export; the Node.js runtime runs on workerd.`,
          { details },
        );
      }
      return warn(
        `${findings.length} file(s) opt into the Edge runtime. HypDriv's server helpers and proxy stages target the Node.js runtime (Edge segments get no nonce/geo context helpers); remove the export unless you need Edge.`,
        { details },
      );
    },
  },
  {
    id: 'next.output-export',
    title: 'output mode',
    category: 'nextjs',
    severity: 'error',
    run(ctx) {
      const nc = ctx.project.nextConfig;
      if (!nc) return skip('no next.config file.');
      if (nc.output === 'export')
        return fail(
          "`output: 'export'` produces a static site; OpenNext Cloudflare and HypDriv need the server build. Remove the option (OpenNext sets what it needs).",
        );
      if (nc.output === 'standalone')
        return pass("`output: 'standalone'` (OpenNext consumes the standalone build).");
      return pass('Default output mode.');
    },
  },
  {
    id: 'next.images',
    title: 'Image optimisation setup',
    category: 'nextjs',
    severity: 'warn',
    run(ctx) {
      const nc = ctx.project.nextConfig;
      const loader = ctx.config.resolved.images.loader;
      if (!nc) return skip('no next.config file.');
      if (nc.imagesUnoptimized)
        return info(
          'images.unoptimized is set; the HypDriv image loader is inactive and <Image> serves originals.',
        );
      if (ctx.project.platform === 'vercel') {
        const explicit = ctx.config.config.images?.loader;
        if (loader === 'cloudflare' && explicit === 'cloudflare')
          return warn(
            "hypdriv.config sets images.loader: 'cloudflare' on Vercel; /cdn-cgi/image does not exist there. Use images.loader: 'next' for Vercel Image Optimization.",
          );
        if (loader === 'cloudflare')
          return info(
            "On Vercel set images.loader: 'next' in hypdriv.config so <Image> uses Vercel Image Optimization instead of the Cloudflare loader.",
          );
        return pass(`images.loader: ${loader}`);
      }
      if (
        loader === 'cloudflare' &&
        nc.imagesLoader &&
        nc.imagesLoader !== 'custom' &&
        nc.imagesLoader !== 'default'
      ) {
        return warn(
          `next.config sets images.loader "${nc.imagesLoader}" while hypdriv.config uses the Cloudflare loader; pick one (set images.loader: 'next' in hypdriv.config to keep yours).`,
        );
      }
      if (loader === 'cloudflare' && nc.imagesLoaderFile && !/hypdriv/.test(nc.imagesLoaderFile)) {
        return warn(
          `next.config sets images.loaderFile "${nc.imagesLoaderFile}"; HypDriv's loader is not applied while a custom loaderFile exists.`,
        );
      }
      return pass(
        loader === 'cloudflare'
          ? 'Cloudflare image loader (applied by withHypDriv).'
          : `images.loader: ${loader}`,
      );
    },
  },
  {
    id: 'next.cache-components',
    title: 'Cache Components',
    category: 'nextjs',
    severity: 'info',
    run(ctx) {
      const on = ctx.manifest?.cacheComponents ?? ctx.project.nextConfig?.cacheComponents ?? false;
      if (on) return pass('cacheComponents is enabled (shell routes are classified and cached per policy).');
      return info(
        'cacheComponents is off. Consider `cacheComponents: true` in next.config for streaming shells; HypDriv classifies them as `shell` and caches them when `cache.edge.inferredShell` is set.',
      );
    },
  },
  {
    id: 'next.deployment-id',
    title: 'Deployment id for skew protection',
    category: 'nextjs',
    severity: 'warn',
    run(ctx) {
      const skew = ctx.config.resolved.performance.skewProtection;
      if (!skew) return skip('skew protection is disabled.');
      if (ctx.project.platform === 'vercel')
        return pass(
          'Vercel assigns the deployment id (VERCEL_DEPLOYMENT_ID); enable Skew Protection in the project settings.',
        );
      const sharedIdRisk =
        "every build then shares one id: Next.js uses a constant BUILD_ID with deployment ids and OpenNext keys its incremental, regional and tag caches by the id, so other builds (and other apps on the same zone) read each other's cached pages";
      if (skew.deploymentId)
        return warn(`deploymentId "${skew.deploymentId}" is a constant in hypdriv.config; ${sharedIdRisk}.`, {
          details: [
            'Remove `performance.skewProtection.deploymentId`: HypDriv derives a per-build id (<commit>-<build stamp>, ADR 0016).',
          ],
        });
      if (ctx.project.nextConfig?.setsDeploymentId)
        return info(
          'next.config sets deploymentId itself; make sure it is unique per build and per app (HypDriv derives <commit>-<build stamp> otherwise).',
        );
      const env = ctx.io.env;
      if (env.HYPDRIV_DEPLOYMENT_ID)
        return info(
          `HYPDRIV_DEPLOYMENT_ID is used verbatim ("${env.HYPDRIV_DEPLOYMENT_ID.slice(0, 64)}"); it must change with every build and differ between apps.`,
        );
      const manifestId = ctx.manifest?.deploymentId ? ` (last build: ${ctx.manifest.deploymentId})` : '';
      const fromEnv =
        env.WORKERS_CI_COMMIT_SHA ?? env.CF_PAGES_COMMIT_SHA ?? env.GITHUB_SHA ?? env.CI_COMMIT_SHA;
      if (fromEnv) return pass(`deploymentId: the CI commit SHA plus a per-build stamp${manifestId}.`);
      if (existsSync(join(ctx.project.repoRoot, '.git')))
        return pass(`deploymentId: the git HEAD plus a per-build stamp${manifestId}.`);
      return pass(`deploymentId: a per-build stamp (no git checkout or CI SHA)${manifestId}.`);
    },
  },
  {
    id: 'next.instrumentation',
    title: 'instrumentation.ts',
    category: 'nextjs',
    severity: 'info',
    run(ctx) {
      const file = ctx.project.instrumentationFile;
      if (!file)
        return info(
          'No instrumentation.ts; `hypdriv init` adds one exporting register/onRequestError from hypdriv/instrumentation for error reporting.',
        );
      const source = readFileSync(file, 'utf8');
      if (/@hypdriv\/next\/instrumentation|hypdriv\/instrumentation/.test(source))
        return pass(`${rel(ctx.root, file)} uses HypDriv's instrumentation helpers.`);
      return pass(`${rel(ctx.root, file)} present (custom).`);
    },
  },
  {
    id: 'next.router',
    title: 'Router layout',
    category: 'nextjs',
    severity: 'warn',
    run(ctx) {
      const { app, pages } = ctx.project.router;
      if (app && pages) return pass('App Router and Pages Router (mixed).');
      if (app) return pass('App Router.');
      if (pages)
        return info(
          'Pages Router only: runtime stages work; CSP hashes, early hints and the speculation graph are derived for App Router pages only.',
        );
      return warn(
        'No app/ or pages/ directory found; is this a Next.js project root? Use --root <dir> to point at it.',
      );
    },
  },
];
