'use client';

import { useState } from 'react';

/** A client component, so pages hydrate (and the CSP has scripts to allow). */
export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((n) => n + 1)}>
      Clicked {count} {count === 1 ? 'time' : 'times'}
    </button>
  );
}
