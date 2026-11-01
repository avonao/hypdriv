import { hyp } from '@hypdriv/nitro/server';
import { defineHandler } from 'nitro';

// The pipeline may read the request body (CSRF form tokens, Turnstile); the route still reads it normally.
export default defineHandler(async (event) => {
  const body = (await event.req.json().catch(() => null)) as Record<string, unknown> | null;
  return { received: body, requestId: hyp()?.requestId ?? null };
});
