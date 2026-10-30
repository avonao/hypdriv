import {
  defineStage,
  HYPDRIV_VERSION,
  type HypContext,
  type ResolvedConfig,
  readEnv,
  type Stage,
} from '@hypdriv/core';
import { encodeFlagsHeader, FLAGS_KEY, publicFlags } from '@hypdriv/flags';
import { LOCALE_KEY } from './i18n';

/** Whether the DevTools HUD may see request facts for this request (`devtools.enabled`). */
export function devtoolsEnabledFor(
  config: ResolvedConfig,
  ctx: Pick<HypContext, 'development' | 'env'>,
): boolean {
  const enabled = config.devtools.enabled;
  if (enabled === true) return true;
  if (enabled === false) return false;
  if (ctx.development) return true;
  if (enabled === 'preview') {
    const env = ctx.env as Record<string, unknown>;
    return (
      readEnv(env, 'HYPDRIV_ENV') === 'preview' ||
      readEnv(env, 'VERCEL_ENV') === 'preview' ||
      readEnv(env, 'NEXTJS_ENV') === 'preview'
    );
  }
  return false;
}

/**
 * The `devtools` stage: exposes per-request facts to the HUD as `Server-Timing` entries
 * (`hyp-request`, `hyp-runner`, `hyp-route`, `hyp-locale`, `hyp-flags`, `hyp-build`, `hyp-deployment`,
 * `hyp-next`, `hyp-version`). The browser exposes them through `PerformanceNavigationTiming.serverTiming`,
 * so pages need no request-dependent markup and stay static. Flags are filtered through `publicFlags`.
 * Only active when `devtools.enabled` allows it for the request.
 */
export function devtoolsStage(config: ResolvedConfig): Stage | null {
  if (config.devtools.enabled === false) return null;
  return defineStage({
    name: 'devtools',
    runOnRsc: true,
    post(ctx, response) {
      if (!devtoolsEnabledFor(config, ctx)) return response;
      const mark = (name: string, value: string | undefined | null) => {
        if (value) ctx.timings.mark(`hyp-${name}`, value);
      };
      mark('request', ctx.id);
      mark('runner', ctx.runner);
      mark('route', ctx.route?.route.id);
      mark('locale', ctx.state.get(LOCALE_KEY)?.locale);
      const flags = ctx.state.get(FLAGS_KEY);
      if (flags) {
        const visible = publicFlags(flags, config.flags.definitions);
        if (Object.keys(visible).length) mark('flags', encodeFlagsHeader(visible));
      }
      mark('build', ctx.manifest.buildId);
      mark('deployment', ctx.manifest.deploymentId);
      mark('next', ctx.manifest.nextVersion !== 'unknown' ? ctx.manifest.nextVersion : undefined);
      mark('version', HYPDRIV_VERSION);
      return response;
    },
  });
}
