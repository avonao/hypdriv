// A Vercel Function (zero-config `api/` directory) next to the Build Output HypDriv writes. HypDriv's Routing
// Middleware runs the request stages (rate limiting, bot shield) before it. On Cloudflare the Worker answers
// /api/time itself (src/worker.ts).
export function GET(): Response {
  return Response.json({ now: Date.now() }, { headers: { 'cache-control': 'no-store' } });
}
