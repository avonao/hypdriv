import { hyp, publish } from 'hypdriv/server';
import { requireInternal } from '@/lib/internal';

/** Signed: publishes `{ channel, type, data }` to a live channel (Durable Object fan-out). */
export async function POST(request: Request) {
  const denied = await requireInternal(request);
  if (denied) return denied;
  const { channel, type, data } = (await request.json()) as { channel: string; type: string; data: unknown };
  const { env } = await hyp();
  return Response.json(await publish(env, channel, { type, data }));
}
