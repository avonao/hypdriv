import { hyp } from '@hypdriv/sveltekit/server';

// Rate limited by the `api` policy in hypdriv.config.ts (60 requests per minute per IP).
export const GET = () =>
  Response.json({
    message: 'Hello from SvelteKit behind Hypdriv',
    requestId: hyp()?.requestId ?? null,
    country: hyp()?.country ?? null,
  });

export const POST = async ({ request }: { request: Request }) => {
  const body = (await request.json().catch(() => null)) as unknown;
  return Response.json({ echo: body, requestId: hyp()?.requestId ?? null });
};
