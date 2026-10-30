'use client';

import { useActionState } from 'react';
import { subscribe } from './actions';

type State = Awaited<ReturnType<typeof subscribe>> | null;

export function SubscribeForm() {
  const [state, action, pending] = useActionState<State, FormData>(async (_prev, formData) => subscribe({ email: formData.get('email') }), null);
  return (
    <form action={action} className="card">
      <label>
        Email <input name="email" type="email" required />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Subscribe'}
      </button>
      {state && !state.ok && <p role="alert">{state.error.message}</p>}
      {state?.ok && <p>Subscribed {state.data.subscribed}.</p>}
    </form>
  );
}
