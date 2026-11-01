import { flag } from '@hypdriv/rwsdk/server';
import { Counter } from '@/app/Counter';

// A server component. flag() reads the edge-evaluated flag of this request (newHero is on for visitors in the US).
export const Home = () => {
  const newHero = flag('newHero', false);
  return (
    <main>
      <h1>{newHero ? 'Welcome to the new hero' : 'Hypdriv on RedwoodSDK'}</h1>
      <p>
        React Server Components on Cloudflare Workers, behind the Hypdriv Drivetrain: security headers, a
        nonce CSP, rate limits and flags at the edge.
      </p>
      <Counter />
    </main>
  );
};
