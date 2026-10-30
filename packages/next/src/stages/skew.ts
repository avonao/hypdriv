import {
  cacheVersion,
  defineStage,
  HEADER,
  isHtmlLike,
  isRscRequest,
  type ResolvedConfig,
  type Stage,
} from '@hypdriv/core';

/**
 * Skew protection assist. Next.js sends `x-deployment-id` on client fetches when `deploymentId` is
 * configured. When a client built for a previous deployment asks for an RSC payload, answering with a
 * non-RSC response makes the App Router perform a full navigation, which loads the new HTML and assets.
 */
export function skewStage(config: ResolvedConfig): Stage | null {
  const skew = config.performance.skewProtection;
  if (!skew) return null;
  return defineStage({
    name: 'skew',
    runOnRsc: true,
    pre(ctx) {
      const current = ctx.manifest.deploymentId ?? skew.deploymentId;
      if (!current) return;
      const requested = ctx.request.headers.get(HEADER.deploymentId);
      if (!requested || requested === current) return;
      ctx.responseHeaders.set(HEADER.skew, '1');
      ctx.timings.mark('skew', 'mismatch');
      if (!skew.reloadOnMismatch || !isRscRequest(ctx.request.headers)) return;
      // A non-RSC response to an RSC request triggers a hard navigation in the Next.js client.
      return new Response('', {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          [HEADER.skew]: '1',
          [HEADER.deploymentId]: current,
        },
      });
    },
    post(ctx, response) {
      const current = ctx.manifest.deploymentId ?? skew.deploymentId;
      if (!current || !isHtmlLike(ctx, response) || response.headers.has(HEADER.deploymentId))
        return response;
      const headers = new Headers(response.headers);
      headers.set(HEADER.deploymentId, current);
      // Next's BUILD_ID is a constant whenever a deployment id exists; the content fingerprint identifies the build.
      headers.set('x-hypdriv-build', cacheVersion(ctx.manifest));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  });
}
