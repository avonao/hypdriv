import { pathTag } from '@hypdriv/cache';
import { type HypManifest, sha256Hex, timingSafeEqual } from '@hypdriv/core';

/** Header Next.js accepts to regenerate a prerendered page (value: the build's preview-mode id). */
export const NEXT_REVALIDATE_HEADER = 'x-prerender-revalidate';

/** Response header Next.js (via OpenNext) sets after regenerating a page. */
export const NEXT_CACHE_HEADER = 'x-nextjs-cache';

/**
 * `true` when the request is one of Next.js's own ISR revalidation requests: OpenNext's revalidation queue
 * (`DOQueueHandler`) re-requests stale pages through `WORKER_SELF_REFERENCE` with
 * `x-prerender-revalidate: <previewModeId>`. The token is checked against the manifest's SHA-256 in
 * constant time, so a client cannot use the header to skip the Drivetrain.
 */
export async function isRevalidationRequest(
  request: Request,
  manifest: Pick<HypManifest, 'revalidation'>,
): Promise<boolean> {
  const expected = manifest.revalidation?.tokenHash;
  if (!expected) return false;
  const token = request.headers.get(NEXT_REVALIDATE_HEADER);
  if (!token || token.length > 256) return false;
  return timingSafeEqual(await sha256Hex(token), expected);
}

/** `true` when Next.js regenerated the page for this response. */
export function wasRevalidated(response: Response): boolean {
  return response.headers.get(NEXT_CACHE_HEADER)?.toUpperCase() === 'REVALIDATED';
}

/** Edge-cache tags holding stale copies of a regenerated page (every variant of the path). */
export function revalidatedTags(pathname: string): string[] {
  const tag = pathTag(pathname);
  return tag ? [tag] : [];
}
