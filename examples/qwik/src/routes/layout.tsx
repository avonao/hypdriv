import { component$, Slot } from '@qwik.dev/core';

export default component$(() => (
  <>
    <header>
      <nav>
        <a href="/">Home</a> · <a href="/about/">About</a> · <a href="/blog/hello/">Blog</a> ·{' '}
        <a href="/dynamic/">Request facts</a> · <a href="/api/hello">API</a>
      </nav>
    </header>
    <main>
      <Slot />
    </main>
  </>
));
