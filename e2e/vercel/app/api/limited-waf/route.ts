export function GET() {
  return Response.json({ ok: true, policy: 'waf' }, { headers: { 'cache-control': 'no-store' } });
}
