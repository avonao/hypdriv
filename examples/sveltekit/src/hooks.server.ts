import { hypdriv } from '@hypdriv/sveltekit/hooks';
import { type Handle, sequence } from '@sveltejs/kit/hooks';

// Hypdriv first: it owns the full response (security headers, CSP, rate limiting, bot shield, geo, flags,
// `/_hypdriv/*`); the application's hooks run inside it and see `hyp()`.
const routeHeader: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('x-example-route', event.route.id ?? 'none');
  return response;
};

export const handle = sequence(hypdriv(), routeHeader);
