import { enqueue } from 'hypdriv/server';
import { requireInternal } from '@/lib/internal';

/** Signed: `{ id, failTimes?, always? }` → the `jobs` queue (Cloudflare Queues, DLQ after max_retries). */
export async function POST(request: Request) {
  const denied = await requireInternal(request);
  if (denied) return denied;
  const body = (await request.json()) as { id: string; failTimes?: number; always?: boolean };
  const result = await enqueue('jobs', { ...body, enqueuedAt: Date.now() });
  return Response.json(result);
}
