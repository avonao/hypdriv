import { hyp } from '@hypdriv/waku/server';
import { Counter } from '../components/counter';

// `hyp()` reads the request Hypdriv is handling, so this page renders per request (render: 'dynamic').
export default async function Dynamic() {
  const context = hyp();
  const newHero = context?.flag('newHero', false) ?? false;
  return (
    <>
      <title>Request facts · Hypdriv on Waku</title>
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
    </>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;
