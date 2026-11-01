import { hyp } from '@hypdriv/waku/server';

// An API route (`_api/api/hello.ts` answers `/api/hello`), rate limited by the `api` policy in hypdriv.config.ts
// (60 requests per minute per IP).
export const GET = async () => {
  const context = hyp();
  return Response.json({
    ok: true,
    requestId: context?.requestId ?? null,
    runner: context?.runner ?? null,
    country: context?.country ?? null,
    flags: context?.flags ?? {},
  });
};
