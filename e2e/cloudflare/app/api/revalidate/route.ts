import { getCurrentContext } from 'hypdriv';
import { getEdgePurger, revalidatePath, revalidateTag } from 'hypdriv/cache';
import { requireInternal } from '@/lib/internal';

/**
 * Signed: `{ tag }` or `{ path }` → Next's tag cache (Durable Object) plus the HypDriv edge cache. Reports
 * whether the request context and the edge purger are visible inside the Next.js bundle.
 */
export async function POST(request: Request) {
  const denied = await requireInternal(request);
  if (denied) return denied;
  const { tag, path } = (await request.json()) as { tag?: string; path?: string };
  if (tag) await revalidateTag(tag, { expire: 0 });
  if (path) await revalidatePath(path);
  return Response.json({
    revalidated: { tag: tag ?? null, path: path ?? null },
    context: Boolean(getCurrentContext()),
    purger: Boolean(getEdgePurger()),
  });
}
