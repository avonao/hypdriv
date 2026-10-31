import { hyp } from '@hypdriv/vinext/server';

// Rate limited by the `api` policy in hypdriv.config.ts (60 requests per minute per IP).
export function GET() {
  const context = hyp();
  return Response.json({
    ok: true,
    requestId: context?.requestId ?? null,
    runner: context?.runner ?? null,
    country: context?.country ?? null,
    flags: context?.flags ?? {},
  });
}
