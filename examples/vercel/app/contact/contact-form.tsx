'use client';

import { useActionState } from 'react';
import { sendMessage } from './actions';

type State = Awaited<ReturnType<typeof sendMessage>> | null;

export function ContactForm() {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_previous, form) =>
      sendMessage({ email: String(form.get('email') ?? ''), message: String(form.get('message') ?? '') }),
    null,
  );
  return (
    <form action={action} className="card">
      <label>
        Email <input name="email" type="email" required autoComplete="email" />
      </label>
      <label>
        Message <textarea name="message" required minLength={10} rows={4} />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Send'}
      </button>
      {state && !state.ok ? <p role="alert">{state.error.message}</p> : null}
      {state?.ok ? <p role="status">Queued via {state.data.transport}.</p> : null}
    </form>
  );
}
