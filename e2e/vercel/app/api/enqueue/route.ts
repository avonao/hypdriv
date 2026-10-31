import { enqueue } from 'hypdriv/server';
import { requireInternal } from '@/lib/internal';

/** Signed: `{ id, failTimes?, queue? }` → `jobs` (or `jobs-once`) through Vercel Queues. */
export async function POST(request: Request) {
  const denied = await requireInternal(request);
  if (denied) return denied;
  const { queue = 'jobs', ...body } = (await request.json()) as {
    id: string;
    failTimes?: number;
    queue?: string;
  };
  const result = await enqueue(queue, { ...body, enqueuedAt: Date.now() });
  return Response.json(result);
}
