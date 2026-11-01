import { hyp } from '@hypdriv/analog/server';
import { defineEventHandler, readBody } from 'h3';

// The pipeline may read the request body (CSRF form tokens, Turnstile); the route still reads it normally.
export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event);
  return { received: body ?? null, requestId: hyp()?.requestId ?? null };
});
