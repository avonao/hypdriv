import { createFileRoute } from '@tanstack/react-router';
import { getRequestFacts } from '../request-facts';

// Rendered per request: the response carries a nonce-based CSP, and TanStack Start puts the same nonce on every
// script and style it renders (router `ssr.nonce`, see src/router.tsx).
export const Route = createFileRoute('/request')({
  loader: () => getRequestFacts(),
  component: RequestPage,
});

function RequestPage() {
  const facts = Route.useLoaderData();
  return (
    <main>
      <h1>This request</h1>
      <dl>
        <dt>Request id</dt>
        <dd data-testid="request-id">{facts.requestId ?? '—'}</dd>
        <dt>CSP nonce</dt>
        <dd data-testid="nonce">{facts.nonce ?? '—'}</dd>
        <dt>Runner</dt>
        <dd data-testid="runner">{facts.runner ?? '—'}</dd>
        <dt>Country</dt>
        <dd>{facts.country ?? 'unknown'}</dd>
        <dt>Flag newHero</dt>
        <dd data-testid="flag">{String(facts.newHero)}</dd>
        <dt>Rendered at</dt>
        <dd>{facts.renderedAt}</dd>
      </dl>
    </main>
  );
}
