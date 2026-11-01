import { component$ } from '@qwik.dev/core';
import type { DocumentHead } from '@qwik.dev/router';
import { Counter } from '../../components/counter';

export default component$(() => (
  <>
    <h1>About</h1>
    <p>
      A second prerendered page: static generation writes dist/about/index.html, which carries its own CSP
      hashes.
    </p>
    <Counter />
  </>
));

export const head: DocumentHead = { title: 'About · Hypdriv on Qwik' };
