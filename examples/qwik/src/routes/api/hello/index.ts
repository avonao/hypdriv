import { hyp } from '@hypdriv/qwik/server';
import type { RequestHandler } from '@qwik.dev/router';

// An endpoint (`src/routes/api/hello/index.ts` answers `/api/hello`), rate limited by the `api` policy in
// hypdriv.config.ts (60 requests per minute per IP).
export const onGet: RequestHandler = ({ json }) => {
  const context = hyp();
  json(200, {
    ok: true,
    requestId: context?.requestId ?? null,
    runner: context?.runner ?? null,
    country: context?.country ?? null,
    flags: context?.flags ?? {},
  });
};
