export function GET() {
  return Response.json({ ok: true, store: 'binding' }, { headers: { 'cache-control': 'no-store' } });
}
