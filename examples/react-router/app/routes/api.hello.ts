import { flag, hyp } from '@hypdriv/react-router/server';

// A resource route: rate-limited by the `/api/**` policy in hypdriv.config.ts.
export function loader() {
  const request = hyp();
  return Response.json({
    hello: 'world',
    requestId: request?.requestId ?? null,
    country: request?.country ?? null,
    newHero: flag('newHero', false),
  });
}
