/** Answers after `?ms=` (≤ 10 s): the upstream the hypFetch timeout check calls. */
export async function GET(request: Request) {
  const ms = Math.min(10_000, Math.max(0, Number(new URL(request.url).searchParams.get('ms')) || 0));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return Response.json({ sleptMs: ms }, { headers: { 'cache-control': 'no-store' } });
}
