import { hyp } from '@hypdriv/solid-start/server';

// An API route (no component): an `endpoint` in the Hypdriv manifest, rate-limited by the `api` policy.
export function GET() {
  return Response.json({ now: new Date().toISOString(), requestId: hyp()?.requestId ?? null });
}
