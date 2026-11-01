import { createAsync } from '@solidjs/router';
import { Show } from 'solid-js';
import { getRequestFacts } from '../request-facts';

export const route = { preload: () => getRequestFacts() };

// Rendered per request: the response carries a nonce-based CSP, and Solid puts the same nonce on every inline script
// it renders (`hypdrivStart()` in src/entry-server.tsx).
export default function RequestPage() {
  // `deferStream` keeps the response open until the facts are in the HTML, not streamed in after the shell.
  const facts = createAsync(() => getRequestFacts(), { deferStream: true });
  return (
    <main>
      <h1>This request</h1>
      <Show when={facts()}>
        {(f) => (
          <dl>
            <dt>Request id</dt>
            <dd data-testid="request-id">{f().requestId ?? '—'}</dd>
            <dt>CSP nonce</dt>
            <dd data-testid="nonce">{f().nonce ?? '—'}</dd>
            <dt>Runner</dt>
            <dd data-testid="runner">{f().runner ?? '—'}</dd>
            <dt>Country</dt>
            <dd>{f().country ?? 'unknown'}</dd>
            <dt>Flag newHero</dt>
            <dd data-testid="flag">{String(f().newHero)}</dd>
            <dt>Rendered at</dt>
            <dd>{f().renderedAt}</dd>
          </dl>
        )}
      </Show>
    </main>
  );
}
