'use client';

import { useActionState } from 'react';
import { subscribe } from './actions';

type State = Awaited<ReturnType<typeof subscribe>> | null;

export function SubscribeForm() {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_prev, form) => subscribe({ email: String(form.get('email') ?? '') }),
    null,
  );
  return (
    <form action={action}>
      <input name="email" type="email" required placeholder="you@example.com" />
      <button type="submit" disabled={pending}>
        Subscribe
      </button>
      <output id="result">{state ? JSON.stringify(state) : ''}</output>
    </form>
  );
}
