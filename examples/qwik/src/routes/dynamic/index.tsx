import { hyp } from '@hypdriv/qwik/server';
import { component$ } from '@qwik.dev/core';
import { type DocumentHead, routeLoader$ } from '@qwik.dev/router';
import { Counter } from '../../components/counter';

// `hyp()` reads the request Hypdriv is handling, so this page renders per request (it is not prerendered).
export const useFacts = routeLoader$(({ headers }) => {
  headers.set('cache-control', 'no-store');
  const context = hyp();
  const newHero = context?.flag('newHero', false) ?? false;
  return {
    newHero,
    requestId: context?.requestId ?? 'none',
    runner: context?.runner ?? 'none',
    route: context?.route ?? 'none',
    nonce: context?.nonce ?? 'none',
    country: context?.country ?? 'unknown',
  };
});

export default component$(() => {
  const facts = useFacts();
  return (
    <>
      <h1>{facts.value.newHero ? 'Welcome to the new hero' : 'Request facts'}</h1>
      <dl>
        <dt>Request id</dt>
        <dd>
          <code id="request-id">{facts.value.requestId}</code>
        </dd>
        <dt>Runner</dt>
        <dd>
          <code id="runner">{facts.value.runner}</code>
        </dd>
        <dt>Route</dt>
        <dd>
          <code id="route">{facts.value.route}</code>
        </dd>
        <dt>CSP nonce</dt>
        <dd>
          <code id="nonce">{facts.value.nonce}</code>
        </dd>
        <dt>Country</dt>
        <dd>
          <code id="country">{facts.value.country}</code>
        </dd>
        <dt>Flag newHero</dt>
        <dd>
          <code id="flag">{String(facts.value.newHero)}</code>
        </dd>
      </dl>
      <Counter />
    </>
  );
});

export const head: DocumentHead = { title: 'Request facts · Hypdriv on Qwik' };
