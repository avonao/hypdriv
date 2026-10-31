export function GET() {
  return Response.json({ ok: true, policy: 'exact' }, { headers: { 'cache-control': 'no-store' } });
}
