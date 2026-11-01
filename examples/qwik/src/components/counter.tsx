import { component$, useSignal } from '@qwik.dev/core';

/** An interactive component: pages resume on the client, so the document carries Qwik's inline scripts. */
export const Counter = component$(() => {
  const count = useSignal(0);
  return (
    <button type="button" onClick$={() => count.value++}>
      Clicked {count.value} {count.value === 1 ? 'time' : 'times'}
    </button>
  );
});
