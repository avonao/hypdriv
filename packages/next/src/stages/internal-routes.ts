import {
  cacheVersion,
  describeCapabilities,
  HYPDRIV_VERSION,
  type HypDrivEnv,
  json,
  readEnv,
} from '@hypdriv/core';
import { createLiveHandler } from '@hypdriv/live';
import { analyticsEngineVitalsSink, logVitalsSink, vitalsHandler } from '@hypdriv/observe';
import { type CspReport, cspReportHandler } from '@hypdriv/security';
import type { Platform } from './index';

export interface InternalRoutesOptions {
  /** Allow the `/dev/*` endpoints (development, preview or a matching `HYPDRIV_DEVTOOLS_TOKEN`). */
  devEndpoints: boolean;
  /** Supplies dev state for the HUD (Purser diagnostics are read from the bundled dev file when present). */
  devState?: () => Promise<Record<string, unknown>>;
}

function cspReportSink(platform: Platform): (report: CspReport) => void {
  const ae = platform.capabilities.analyticsEngine
    ? (platform.env[platform.config.cloudflare.bindings.analyticsEngine] as {
        writeDataPoint(e: { indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }): void;
      })
    : null;
  return (report) => {
    platform.log.warn('csp violation', {
      directive: report.effectiveDirective,
      blocked: report.blockedUri,
      document: report.documentUri,
      disposition: report.disposition,
    });
    ae?.writeDataPoint({
      indexes: ['csp'],
      blobs: [
        report.effectiveDirective ?? null,
        report.blockedUri ?? null,
        report.documentUri ?? null,
        report.disposition ?? null,
        report.sourceFile ?? null,
      ],
      doubles: [1, report.ts ?? Date.now()],
    });
  };
}

/** Builds the handler for `/_hypdriv/*`. Returns `null` for non-internal paths. */
export function internalRoutes(
  platform: Platform,
  options: InternalRoutesOptions,
): (
  request: Request,
  info: { ip: string; country?: string; waitUntil(p: Promise<unknown>): void },
) => Promise<Response | null> {
  const prefix = platform.config.cloudflare.internalPathPrefix;
  const vitalsConfig = platform.config.observe.vitals;
  const vitals = vitalsConfig
    ? vitalsHandler({
        sink:
          platform.vitalsSink ??
          (platform.capabilities.analyticsEngine && vitalsConfig.sink === 'analytics-engine'
            ? analyticsEngineVitalsSink(platform.env[vitalsConfig.analyticsEngineBinding] as never)
            : logVitalsSink(platform.log)),
        sampleRate: vitalsConfig.sampleRate,
        ...(platform.config.site.origin ? { allowOrigin: platform.config.site.origin } : {}),
      })
    : null;
  const csp = platform.config.security.csp?.reportTo
    ? cspReportHandler({ sink: cspReportSink(platform) })
    : null;
  const live = platform.config.live.enabled
    ? createLiveHandler(platform.config, platform.env as HypDrivEnv)
    : null;
  const vitalsPath = vitalsConfig?.endpoint ?? `${prefix}/vitals`;
  const cspPath = platform.config.security.csp?.reportTo ?? `${prefix}/csp-report`;
  const livePath = platform.config.live.path;
  const noStore = { 'cache-control': 'no-store' };

  // HypDriv's own deployment id (Cloudflare, skew protection) or the platform's (Vercel sets no Next.js
  // deploymentId without Skew Protection, but every function knows VERCEL_DEPLOYMENT_ID).
  const deploymentId =
    platform.manifest.deploymentId ??
    readEnv(platform.env as Record<string, unknown>, 'VERCEL_DEPLOYMENT_ID') ??
    null;

  return async (request, info) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith(`${prefix}/`) && path !== prefix && path !== vitalsPath && path !== cspPath)
      return null;

    if (path === `${prefix}/health` && platform.config.cloudflare.health) {
      return json(
        {
          ok: true,
          service: platform.config.site.name,
          hypdriv: HYPDRIV_VERSION,
          build: cacheVersion(platform.manifest),
          deployment: deploymentId,
          next: platform.manifest.nextVersion,
          routes: platform.manifest.routes.length,
          capabilities: describeCapabilities(platform.capabilities),
        },
        { headers: noStore },
      );
    }
    if (path === vitalsPath && vitals) {
      if (request.method === 'OPTIONS' || request.method === 'POST')
        return vitals(request, { ip: info.ip, ...(info.country ? { country: info.country } : {}) });
      return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } });
    }
    if (path === cspPath && csp) {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
      return csp(request);
    }
    if (live && (path === livePath || path.startsWith(`${livePath}/`))) {
      return live(request, { waitUntil: info.waitUntil });
    }
    if (path.startsWith(`${prefix}/dev/`)) {
      const token = readEnv(platform.env as Record<string, unknown>, 'HYPDRIV_DEVTOOLS_TOKEN');
      const allowed = options.devEndpoints || (token && url.searchParams.get('token') === token);
      if (!allowed) return json({ error: 'not_available' }, { status: 404, headers: noStore });
      if (path === `${prefix}/dev/state`) {
        const extra = options.devState ? await options.devState() : {};
        return json(
          {
            runner: platform.runner,
            development: platform.development,
            build: cacheVersion(platform.manifest),
            deployment: deploymentId,
            nextBuildId: platform.manifest.buildId,
            next: platform.manifest.nextVersion,
            hypdriv: HYPDRIV_VERSION,
            capabilities: platform.capabilities,
            summary: describeCapabilities(platform.capabilities),
            stages: platform.config.stages,
            cacheComponents: platform.manifest.cacheComponents,
            routes: platform.manifest.routes
              .filter((r) => r.kind !== 'static-file')
              .map((r) => ({
                pathname: r.pathname,
                classification: r.classification,
                cachePolicyId: r.cachePolicyId ?? null,
              })),
            ...extra,
          },
          { headers: noStore },
        );
      }
      if (path === `${prefix}/dev/manifest`) return json(platform.manifest, { headers: noStore });
      if (path === `${prefix}/dev/purser`) {
        const extra = options.devState ? await options.devState() : {};
        return json(extra.purser ?? { ok: true, diagnostics: [], note: 'bridge not running' }, {
          headers: noStore,
        });
      }
    }
    return json({ error: 'not_found' }, { status: 404, headers: noStore });
  };
}
