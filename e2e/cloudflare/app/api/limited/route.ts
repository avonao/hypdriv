export function GET() {
  return Response.json({ ok: true, store: 'durable-object' }, { headers: { 'cache-control': 'no-store' } });
}
