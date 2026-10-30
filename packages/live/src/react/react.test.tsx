import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveProvider, useLive, useLiveRefresh, useLiveValue } from './index';

function Feed({ enabled = true }: { enabled?: boolean }) {
  const { status, events, lastEvent, transport, error } = useLive<{ n: number }>('orders', { enabled });
  return (
    <div data-status={status} data-transport={String(transport)} data-error={String(error)}>
      {`${events.length} events; last ${lastEvent ? lastEvent.id : 'none'}`}
    </div>
  );
}

function Counter() {
  const value = useLiveValue<number>('counter', 41);
  return <output>{value}</output>;
}

function Refresher() {
  let calls = 0;
  const { status } = useLiveRefresh('orders', () => {
    calls++;
  });
  return <p>{`${status}:${calls}`}</p>;
}

describe('@hypdriv/live/react (SSR)', () => {
  it('renders without connecting on the server', () => {
    const html = renderToString(<Feed />);
    expect(html).toContain('data-status="connecting"');
    expect(html).toContain('data-transport="null"');
    expect(html).toContain('0 events; last none');
  });

  it('reports closed when disabled', () => {
    expect(renderToString(<Feed enabled={false} />)).toContain('data-status="closed"');
  });

  it('useLiveValue returns the initial value and useLiveRefresh exposes status', () => {
    expect(renderToString(<Counter />)).toContain('<output>41</output>');
    expect(renderToString(<Refresher />)).toContain('connecting:0');
  });

  it('LiveProvider nests and renders children', () => {
    const html = renderToString(
      <LiveProvider path="/realtime" transport="websocket">
        <LiveProvider pollIntervalMs={1000}>
          <Feed />
        </LiveProvider>
      </LiveProvider>,
    );
    expect(html).toContain('data-status="connecting"');
  });
});
