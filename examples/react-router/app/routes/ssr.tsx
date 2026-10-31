import { flag, hypdrivContext, requireHyp } from '@hypdriv/react-router/server';
import type { Route } from './+types/ssr';

// Vercel function settings for this route (read by `@vercel/react-router`; Hypdriv deploys it as its own function).
export const config = { maxDuration: 15 };

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Request facts · Hypdriv × React Router' }];
}

// Rendered per request inside the Hypdriv request context: `hyp()` / `requireHyp()` anywhere on the server, or the
// same view from the router context.
export function loader({ context }: Route.LoaderArgs) {
  const request = requireHyp();
  const fromContext = context.get(hypdrivContext);
  return {
    requestId: request.requestId,
    nonce: request.nonce,
    runner: request.runner,
    route: request.route,
    country: request.country,
    newHero: flag('newHero', false),
    contextMatches: fromContext?.requestId === request.requestId,
  };
}

export default function Ssr({ loaderData }: Route.ComponentProps) {
  return (
    <section>
      <h1>{loaderData.newHero ? 'Request facts (new hero)' : 'Request facts'}</h1>
      <dl>
        <dt>Request id</dt>
        <dd data-testid="request-id">{loaderData.requestId}</dd>
        <dt>CSP nonce</dt>
        <dd data-testid="nonce">{loaderData.nonce ?? 'none'}</dd>
        <dt>Runner</dt>
        <dd>{loaderData.runner}</dd>
        <dt>Route</dt>
        <dd>{loaderData.route ?? 'unmatched'}</dd>
        <dt>Country</dt>
        <dd>{loaderData.country ?? 'unknown'}</dd>
        <dt>Flag newHero</dt>
        <dd data-testid="flag">{String(loaderData.newHero)}</dd>
        <dt>Router context</dt>
        <dd>{loaderData.contextMatches ? 'same request' : 'missing'}</dd>
      </dl>
    </section>
  );
}
