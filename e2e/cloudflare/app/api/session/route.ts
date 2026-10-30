import { createSessionStore, hyp } from 'hypdriv/server';

async function store() {
  const { env } = await hyp();
  return createSessionStore<{ visits: number }>({
    secret: String(env.HYPDRIV_SESSION_SECRET ?? ''),
    ttlSeconds: 3600,
  });
}

/** Encrypted cookie session: each POST increments `visits`; GET reads it back. */
export async function GET(request: Request) {
  const session = await (await store()).read(request.headers);
  return Response.json({ visits: session.data?.visits ?? 0 }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const sessions = await store();
  const session = await sessions.read(request.headers);
  const visits = (session.data?.visits ?? 0) + 1;
  const cookie = await sessions.write({ visits });
  return Response.json({ visits }, { headers: { 'set-cookie': cookie, 'cache-control': 'no-store' } });
}
