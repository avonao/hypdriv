import { resolvePolicies } from '@hypdriv/cache';
import type { ExperimentSpec, FlagDefinition } from '@hypdriv/core';
import { emptyManifest, MAX_EXPERIMENT_COPIES, matchesAny, runningExperiments } from '@hypdriv/core';
import { concretePaths, isPageRoute } from '../../audit/paths';
import { type Check, info, pass, skip, warn } from '../types';

type Ctx = Parameters<Check['run']>[0];

function running(ctx: Ctx): Array<{ name: string; spec: ExperimentSpec }> {
  const definitions = ctx.config.resolved.flags.definitions;
  return runningExperiments(definitions).map((name) => ({
    name,
    spec: (definitions[name] as FlagDefinition & { experiment: ExperimentSpec }).experiment,
  }));
}

/** Every variant counts: a visitor who was assigned one keeps it after its weight drops to 0. */
const variantCount = (spec: ExperimentSpec) => Object.keys(spec.variants).length;

interface AffectedPolicy {
  id: string;
  source: 'explicit' | 'inferred';
  experiments: string[];
  /** Cached copies one URL of this policy can have: the product of the variants of those experiments. */
  copies: number;
}

/** The cache policies (configured and, once the app is built, inferred static/ISR ones) that vary on a running experiment. */
function affectedPolicies(ctx: Ctx, experiments: ReturnType<typeof running>): AffectedPolicy[] {
  const variants = new Map(experiments.map((e) => [e.name, variantCount(e.spec)]));
  const manifest = ctx.project.manifest?.data ?? emptyManifest();
  return resolvePolicies(ctx.config.resolved, manifest)
    .map((policy) => {
      const names = policy.vary.flags.filter((name) => variants.has(name));
      return {
        id: policy.id,
        source: policy.source,
        experiments: names,
        copies: names.reduce((n, name) => n * Math.max(variants.get(name) ?? 1, 1), 1),
      };
    })
    .filter((policy) => policy.experiments.length > 0);
}

function describePolicies(affected: AffectedPolicy[]): string {
  const explicit = affected.filter((p) => p.source === 'explicit').map((p) => p.id);
  const inferred = affected.length - explicit.length;
  return [
    ...(explicit.length ? [`the polic${explicit.length === 1 ? 'y' : 'ies'} ${explicit.join(', ')}`] : []),
    ...(inferred ? [`${inferred} inferred static/ISR route polic${inferred === 1 ? 'y' : 'ies'}`] : []),
  ].join(' and ');
}

export const experimentChecks: Check[] = [
  {
    id: 'experiments.cache',
    title: 'Experiments and the edge cache',
    category: 'hypdriv',
    severity: 'warn',
    run(ctx) {
      const experiments = running(ctx);
      if (!experiments.length) return skip('no running experiments.');
      const edge = ctx.config.resolved.cache.edge;
      if (!edge) return pass('Edge cache is off; every request is assigned and rendered on its own.');
      const affected = affectedPolicies(ctx, experiments);
      const optedOut = edge.policies.filter((p) => !p.vary.experiments).map((p) => p.id);
      const details = [
        ...experiments.map((e) => `${e.name}: ${variantCount(e.spec)} variants`),
        ...(optedOut.length ? [`vary.experiments is off for: ${optedOut.join(', ')}`] : []),
        ...(ctx.project.manifest?.data
          ? []
          : [
              'No build manifest yet: the inferred static/ISR policies are not counted. Build the app and run doctor again.',
            ]),
        'Experiments that only a remote flag provider defines are not known here: list them in vary.flags.',
      ];
      if (ctx.project.platform === 'vercel') {
        // Vercel's CDN keys a cached response by URL and Vary request headers only: it cannot hold one copy per variant.
        // The CDN stage therefore leaves every policy that varies on an experiment uncached (reason `vary:flags`).
        if (!affected.length)
          return pass(
            `No cache policy varies on ${experiments.map((e) => e.name).join(', ')}, so the Vercel CDN keeps caching as configured.`,
            { details },
          );
        return warn(
          `Running ${experiments.length === 1 ? 'experiment' : 'experiments'} ${experiments.map((e) => e.name).join(', ')} keep the Vercel CDN from caching ${describePolicies(affected)}: the CDN keys a cached response by URL and Vary request headers only, so it cannot hold one copy per variant, and Hypdriv leaves those pages uncached rather than show a visitor another's variant. Set vary.experiments: false on policies whose pages do not depend on the experiment (static pages usually do not), or conclude the experiment.`,
          { details },
        );
      }
      // Without a known policy (nothing built yet, or only a remote provider's experiments), the bound is every experiment.
      const copies = affected.length
        ? Math.max(...affected.map((p) => p.copies))
        : experiments.reduce((n, e) => n * Math.max(variantCount(e.spec), 1), 1);
      if (copies > MAX_EXPERIMENT_COPIES)
        return warn(
          `${experiments.length} running experiments give cached pages up to ${copies} copies each (one per variant combination), which hurts the hit ratio; the warm-up and the URL purge cover at most ${MAX_EXPERIMENT_COPIES}. Conclude finished experiments, or set vary.experiments: false on policies whose pages do not depend on them.`,
          { details },
        );
      return pass(
        `Cached pages vary on ${experiments.map((e) => e.name).join(', ')} (up to ${copies} cached ${copies === 1 ? 'copy' : 'copies'} per page), so a cached page never shows another visitor's variant.`,
        { details },
      );
    },
  },
  {
    id: 'experiments.static-pages',
    title: 'Experiments on pages the static layer serves',
    category: 'hypdriv',
    severity: 'warn',
    run(ctx) {
      const experiments = running(ctx);
      if (!experiments.length) return skip('no running experiments.');
      const manifest = ctx.project.manifest?.data;
      if (!manifest) return skip('no build manifest.');
      // A prerendered document the platform's static layer serves (Workers Static Assets, the Vercel CDN,
      // `hypdriv serve`) is answered before Hypdriv runs: no variant is assigned, no cookie set, nobody counted.
      const paths = manifest.routes
        .filter((route) => isPageRoute(route) && route.servedStatically)
        .flatMap((route) => concretePaths(route, manifest.basePath ?? ''));
      if (!paths.length) return pass('No page is served by the static layer before Hypdriv runs.');
      const stuck = experiments
        .filter((e) => e.spec.expose?.length)
        .map((e) => ({
          name: e.name,
          paths: paths.filter((path) =>
            matchesAny(e.spec.expose!, new URL(path, 'https://hypdriv.internal')),
          ),
        }))
        .filter((e) => e.paths.length);
      if (stuck.length)
        return warn(
          `${stuck.map((e) => `${e.name} (${e.paths.slice(0, 3).join(', ')}${e.paths.length > 3 ? ', …' : ''})`).join('; ')}: pages in \`expose\` are prerendered files the static layer serves before Hypdriv runs, so no visitor is assigned or counted there. Render them on demand (not prerendered), or move the experiment to a page that is.`,
          { details: stuck.flatMap((e) => e.paths.map((path) => `${e.name}: ${path}`)) },
        );
      return info(
        `${paths.length} prerendered page(s) are served by the static layer before Hypdriv runs (${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}); experiments neither assign nor count visitors there.`,
      );
    },
  },
  {
    id: 'experiments.exposures',
    title: 'Experiment exposures',
    category: 'hypdriv',
    severity: 'info',
    run(ctx) {
      const experiments = running(ctx);
      if (!experiments.length) return skip('no running experiments.');
      const flags = ctx.config.resolved.flags;
      const binding = flags.exposuresBinding;
      const bound = ctx.project.wrangler.config?.analytics_engine_datasets.some((a) => a.binding === binding);
      if (flags.exposures === 'none')
        return info('flags.exposures is "none": variants are assigned but nobody is counted.');
      if (ctx.project.platform !== 'cloudflare') {
        if (flags.exposures === 'analytics-engine')
          return warn(
            `flags.exposures is 'analytics-engine', but Analytics Engine is a Cloudflare feature; on ${ctx.project.platform ?? 'this platform'} exposures go to the log (\`experiment exposure\` lines).`,
          );
        return info(
          'Exposures go to the log (one `experiment exposure` line per visitor and experiment); query your log drain for results.',
        );
      }
      if (bound)
        return pass(
          `Exposures are written to Analytics Engine (${binding}); \`hypdriv experiments --results\` reads them.`,
        );
      if (flags.exposures === 'analytics-engine')
        return warn(
          `flags.exposures is 'analytics-engine', but no analytics_engine_datasets entry binds ${binding}; exposures fall back to the log.`,
        );
      return info(
        `Exposures go to the log. Bind ${binding} (\`"analytics_engine_datasets": [{ "binding": "${binding}", "dataset": "<name>" }]\`) to count visitors per variant with \`hypdriv experiments --results\`.`,
      );
    },
  },
  {
    id: 'experiments.vitals',
    title: 'Web Vitals per variant',
    category: 'hypdriv',
    severity: 'info',
    run(ctx) {
      const experiments = running(ctx);
      if (!experiments.length) return skip('no running experiments.');
      const r = ctx.config.resolved;
      const vitals = r.observe.vitals;
      if (!vitals)
        return info(
          'observe.vitals is off, so variants are compared on exposures only. Turn it on (and render <VitalsReporter />) to compare LCP, INP and CLS per variant.',
        );
      if (ctx.project.platform !== 'cloudflare' || r.flags.exposures === 'none')
        return skip('exposures are not stored.');
      if (vitals.sink !== 'analytics-engine')
        return info(
          `observe.vitals.sink is '${vitals.sink}': per-variant Web Vitals need the 'analytics-engine' sink (the beacon tags each measurement with the visitor's variants).`,
        );
      if (vitals.analyticsEngineBinding !== r.flags.exposuresBinding)
        return warn(
          `Vitals go to ${vitals.analyticsEngineBinding} and exposures to ${r.flags.exposuresBinding}; \`hypdriv experiments\` reads both from one dataset. Point flags.exposuresBinding at ${vitals.analyticsEngineBinding} (or the reverse).`,
        );
      return pass("Vitals beacons carry the visitor's variants into the same dataset as the exposures.");
    },
  },
];
