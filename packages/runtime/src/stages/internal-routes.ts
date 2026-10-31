import { getEdgePurger } from '@hypdriv/cache';
import {
  cacheVersion,
  describeCapabilities,
  frameworkLabel,
  HYPDRIV_VERSION,
  type HypDrivEnv,
  json,
  readEnv,
} from '@hypdriv/core';
import { createLiveHandler } from '@hypdriv/live';
import { analyticsEngineVitalsSink, logVitalsSink, vitalsHandler } from '@hypdriv/observe';
import { type CspReport, cspReportHandler, verifyPurgeToken } from '@hypdriv/security';
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

const PURGE_MAX_ITEMS = 200;
const PURGE_MAX_BODY = 64 * 1024;

function stringList(value: unknown, what: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${what} must be an array of strings`;
  if (value.length > PURGE_MAX_ITEMS) return `${what} accepts at most ${PURGE_MAX_ITEMS} entries`;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.length > 2048)
      return `${what} must hold non-empty strings of at most 2048 characters`;
    out.push(item);
  }
  return out;
}

/**
 * `POST /_hypdriv/purge` with an `x-hypdriv-purge` token (`hypdriv purge`): purges cache tags and URLs from
 * every tier of the edge cache (memory, Cache API, KV), the tag index and the zone. Answers `404` to anything
 * not signed with the internal secret, so the route does not exist for visitors. A raw Cloudflare tag purge
 * only clears the Cache API tier; the KV copy would refill it.
 */
async function purgeRoute(
  platform: Platform,
  request: Request,
  url: URL,
  token: string | undefined,
): Promise<Response> {
  const noStore = { 'cache-control': 'no-store' };
  const hidden = () => json({ error: 'not_found' }, { status: 404, headers: noStore });
  if (request.method !== 'POST') return hidden();
  const secret = readEnv(
    platform.env as Record<string, unknown>,
    platform.config.security.internalAuth.secretEnv,
  );
  if (!secret || !token) return hidden();
  const hosts = new Set([url.hostname.toLowerCase()]);
  const hostHeader = request.headers.get('host');
  if (hostHeader)
    hosts.add(
      hostHeader
        .replace(/:\d+$/, '')
        .replace(/^\[|\]$/g, '')
        .toLowerCase(),
    );
  let ok = false;
  for (const host of hosts) {
    if (await verifyPurgeToken(token, secret, { host })) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    platform.log.warn('invalid purge token', { hosts: [...hosts] });
    return hidden();
  }
  const purger = getEdgePurger();
  if (!purger) return json({ ok: false, error: 'no_edge_cache' }, { status: 409, headers: noStore });
  const text = await request.text();
  if (text.length > PURGE_MAX_BODY)
    return json({ ok: false, error: 'body_too_large' }, { status: 413, headers: noStore });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, { status: 400, headers: noStore });
  }
  const tags = stringList(body.tags, 'tags');
  const urls = stringList(body.urls, 'urls');
  const paths = stringList(body.paths, 'paths');
  for (const list of [tags, urls, paths])
    if (typeof list === 'string') return json({ ok: false, error: list }, { status: 400, headers: noStore });
  const absolute: string[] = [...(urls as string[])];
  for (const path of paths as string[]) {
    if (!path.startsWith('/'))
      return json({ ok: false, error: 'paths must start with /' }, { status: 400, headers: noStore });
    absolute.push(new URL(path, url.origin).toString());
  }
  if (!(tags as string[]).length && !absolute.length)
    return json({ ok: false, error: 'give tags, urls or paths' }, { status: 400, headers: noStore });
  const purgedTags = (tags as string[]).length ? await purger.purgeTags(tags as string[]) : 0;
  const purgedUrls = absolute.length ? await purger.purgeUrls(absolute) : 0;
  platform.log.info('purge requested', { tags: (tags as string[]).length, urls: absolute.length });
  return json(
    {
      ok: true,
      tags: (tags as string[]).length,
      urls: absolute.length,
      entriesRemoved:
        (typeof purgedTags === 'number' ? purgedTags : 0) + (typeof purgedUrls === 'number' ? purgedUrls : 0),
    },
    { headers: noStore },
  );
}

/** Builds the handler for `/_hypdriv/*`. Returns `null` for non-internal paths. */
export function internalRoutes(
  platform: Platform,
  options: InternalRoutesOptions,
): (
  request: Request,
  info: {
    ip: string;
    country?: string;
    /**
     * The `x-hypdriv-purge` header of the original request. The runners strip client-supplied `x-hypdriv-*` headers
     * before the stages run, so this route (the only one that reads one) gets it from here.
     */
    purgeToken?: string | null;
    waitUntil(p: Promise<unknown>): void;
  },
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
          framework: frameworkLabel(platform.manifest),
          next: platform.manifest.nextVersion ?? null,
          runner: platform.runner,
          target: platform.target,
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
    if (path === `${prefix}/purge`) return purgeRoute(platform, request, url, info.purgeToken ?? undefined);
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
            framework: frameworkLabel(platform.manifest),
            next: platform.manifest.nextVersion ?? null,
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
