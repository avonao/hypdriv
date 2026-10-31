import { hyp } from '@hypdriv/vinext/server';
import { Counter } from '../counter';

// `hyp()` reads the request Hypdriv is handling, so (like `headers()`) it renders this page per request.
export default function Dynamic() {
  const context = hyp();
  const newHero = context?.flag('newHero', false) ?? false;
  return (
    <>
      <h1>{newHero ? 'Welcome to the new hero' : 'Request facts'}</h1>
      <dl>
        <dt>Request id</dt>
        <dd>
          <code id="request-id">{context?.requestId ?? 'none'}</code>
        </dd>
        <dt>Runner</dt>
        <dd>
          <code id="runner">{context?.runner ?? 'none'}</code>
        </dd>
        <dt>Route</dt>
        <dd>
          <code id="route">{context?.route ?? 'none'}</code>
        </dd>
        <dt>CSP nonce</dt>
        <dd>
          <code id="nonce">{context?.nonce ?? 'none'}</code>
        </dd>
        <dt>Country</dt>
        <dd>
          <code id="country">{context?.country ?? 'unknown'}</code>
        </dd>
        <dt>Flag newHero</dt>
        <dd>
          <code id="flag">{String(newHero)}</code>
        </dd>
      </dl>
      <Counter />
      {/* An inline script of the application's own: it carries the request's nonce. */}
      <script
        nonce={context?.nonce ?? undefined}
        dangerouslySetInnerHTML={{ __html: 'document.documentElement.dataset.hypdriv = "nonce-ok";' }}
      />
    </>
  );
}
