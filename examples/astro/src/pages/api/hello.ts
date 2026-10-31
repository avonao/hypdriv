import { hyp } from '@hypdriv/astro/server';
import type { APIRoute } from 'astro';

// An on-demand endpoint behind the `api` rate-limit policy of hypdriv.config.ts.
export const prerender = false;

export const GET: APIRoute = () => {
  const ctx = hyp();
  return Response.json({
    hello: 'astro',
    requestId: ctx?.requestId ?? null,
    runner: ctx?.runner ?? null,
    country: ctx?.country ?? null,
    flags: ctx?.flags ?? {},
  });
};
