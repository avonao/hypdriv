import { hyp } from 'hypdriv/server';

export async function GET() {
  const ctx = await hyp();
  return Response.json(
    {
      geo: ctx.geo,
      country: ctx.country,
      colo: ctx.cf?.colo ?? null,
      runner: ctx.runner,
      requestId: ctx.requestId,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
