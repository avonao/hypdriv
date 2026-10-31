import { hyp, publish } from 'hypdriv/server';
import { requireInternal } from '@/lib/internal';

/** Signed: publishes `{ channel, type, data }`; on Vercel there is no Durable Object, so it reports polling mode. */
export async function POST(request: Request) {
  const denied = await requireInternal(request);
  if (denied) return denied;
  const { channel, type, data } = (await request.json()) as { channel: string; type: string; data: unknown };
  const { env } = await hyp();
  return Response.json(await publish(env, channel, { type, data }));
}
