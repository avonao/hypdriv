'use client';

import { useLive } from 'hypdriv/client';

export function LiveFeed() {
  const { events, status } = useLive<{ text: string }>('e2e');
  return (
    <>
      <p id="status">{status}</p>
      <ul id="events">
        {events.map((e) => (
          <li key={e.id}>{e.data?.text}</li>
        ))}
      </ul>
    </>
  );
}
