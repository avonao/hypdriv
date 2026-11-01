import { hyp } from '@hypdriv/rwsdk/server';
import type { RequestInfo } from 'rwsdk/worker';

// A dynamic route (`/products/:id`). hyp() is the Hypdriv request context: request id, runner, matched route,
// the CSP nonce, geo and flags of the request being rendered.
export const Product = ({ params }: RequestInfo<{ id: string }>) => {
  const context = hyp();
  return (
    <main>
      <h1>Product {params.id}</h1>
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
      </dl>
    </main>
  );
};
