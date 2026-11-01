import type { ExperimentSpec, FlagDefinition } from '@hypdriv/core';
import { runningExperiments } from '@hypdriv/core';
import { type Check, info, pass, skip, warn } from '../types';

type Ctx = Parameters<Check['run']>[0];

/** Above this many cached copies per page the fragmentation costs more than it tells. */
const MAX_CACHE_COPIES = 16;

function running(ctx: Ctx): Array<{ name: string; spec: ExperimentSpec }> {
  const definitions = ctx.config.resolved.flags.definitions;
  return runningExperiments(definitions).map((name) => ({
    name,
    spec: (definitions[name] as FlagDefinition & { experiment: ExperimentSpec }).experiment,
  }));
}

const variantCount = (spec: ExperimentSpec) => Object.values(spec.variants).filter((w) => w > 0).length;

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
      const copies = experiments.reduce((n, e) => n * Math.max(variantCount(e.spec), 1), 1);
      const optedOut = edge.policies.filter((p) => !p.vary.experiments).map((p) => p.id);
      const details = [
        ...experiments.map((e) => `${e.name}: ${variantCount(e.spec)} variants`),
        ...(optedOut.length ? [`vary.experiments is off for: ${optedOut.join(', ')}`] : []),
        'Experiments that only a remote flag provider defines are not known here: list them in vary.flags.',
      ];
      if (copies > MAX_CACHE_COPIES)
        return warn(
          `${experiments.length} running experiments give every cached page up to ${copies} copies (one per variant combination), which hurts the hit ratio. Conclude finished experiments, or set vary.experiments: false on policies whose pages do not depend on them.`,
          { details },
        );
      return pass(
        `Cached pages vary on ${experiments.map((e) => e.name).join(', ')} (up to ${copies} cached ${copies === 1 ? 'copy' : 'copies'} per page), so a cached page never shows another visitor's variant.`,
        { details },
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
