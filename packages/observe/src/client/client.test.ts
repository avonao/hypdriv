import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVitalsReporter, readHypDrivHeaders, readServerTiming, reportVitals } from './index';

interface FakeDom {
  visibility: 'visible' | 'hidden';
  metas: Record<string, string>;
  beacons: Array<{ url: string; body: string }>;
  fetches: Array<{ url: string; init: RequestInit }>;
  listeners: Map<string, Array<() => void>>;
  fire(event: string): void;
  beaconResult: boolean;
}

function installDom(
  serverTiming: Array<{ name: string; duration: number; description: string }> = [],
): FakeDom {
  const dom: FakeDom = {
    visibility: 'visible',
    metas: {},
    beacons: [],
    fetches: [],
    listeners: new Map(),
    beaconResult: true,
    fire(event) {
      for (const l of dom.listeners.get(event) ?? []) l();
    },
  };
  const metaEl = (name: string, content: string) => ({
    getAttribute: (attr: string) => (attr === 'name' ? name : attr === 'content' ? content : null),
  });
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', {
    get visibilityState() {
      return dom.visibility;
    },
    querySelectorAll: (selector: string) =>
      selector.startsWith('meta[name^="hypdriv:"]')
        ? Object.entries(dom.metas).map(([k, v]) => metaEl(`hypdriv:${k}`, v))
        : [],
  });
  vi.stubGlobal('location', { pathname: '/blog/hello' });
  vi.stubGlobal('navigator', {
    sendBeacon: (url: string, body: string) => {
      dom.beacons.push({ url, body });
      return dom.beaconResult;
    },
  });
  vi.stubGlobal('performance', {
    getEntriesByType: (type: string) =>
      type === 'navigation'
        ? [{ serverTiming, type: 'navigate', responseStart: 120, activationStart: 0 }]
        : [],
  });
  vi.stubGlobal('addEventListener', (event: string, listener: () => void) => {
    dom.listeners.set(event, [...(dom.listeners.get(event) ?? []), listener]);
  });
  vi.stubGlobal('removeEventListener', (event: string, listener: () => void) => {
    dom.listeners.set(
      event,
      (dom.listeners.get(event) ?? []).filter((l) => l !== listener),
    );
  });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    dom.fetches.push({ url, init });
    return new Response(null, { status: 204 });
  });
  return dom;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('readServerTiming / readHypDrivHeaders', () => {
  it('maps navigation serverTiming entries to TimingEntry[]', () => {
    installDom([
      { name: 'cache', duration: 0, description: 'HIT' },
      { name: 'next', duration: 12.5, description: '' },
      { name: 'total', duration: 14, description: '' },
    ]);
    expect(readServerTiming()).toEqual([
      { name: 'cache', desc: 'HIT' },
      { name: 'next', dur: 12.5 },
      { name: 'total', dur: 14 },
    ]);
  });

  it('returns [] without a performance API and reads meta tags with the cache fallback', () => {
    vi.stubGlobal('performance', undefined);
    expect(readServerTiming()).toEqual([]);
    const dom = installDom([{ name: 'cache', duration: 0, description: 'STALE' }]);
    dom.metas = { route: 'app:/blog/[slug]', build: 'b1', requestId: 'r1' };
    expect(readHypDrivHeaders()).toEqual({
      route: 'app:/blog/[slug]',
      build: 'b1',
      requestId: 'r1',
      cache: 'STALE',
    });
    dom.metas.cache = 'HIT';
    expect(readHypDrivHeaders().cache).toBe('HIT');
  });
});

describe('createVitalsReporter', () => {
  it('queues metrics with attribution and sends them with sendBeacon when the page hides', () => {
    vi.useFakeTimers();
    const dom = installDom([{ name: 'cache', duration: 0, description: 'HIT' }]);
    dom.metas = { route: 'app:/blog/[slug]', build: 'b1' };
    const reporter = createVitalsReporter({ extra: () => ({ tenant: 't1' }) });
    reporter.report({
      name: 'LCP',
      value: 1800,
      rating: 'good',
      id: 'v4-1',
      delta: 1800,
      navigationType: 'navigate',
      attribution: { element: 'img' },
    });
    reporter.report({ name: 'FID', value: 1, id: 'x' } as never); // unknown metric ignored
    expect(dom.beacons).toHaveLength(0);
    dom.visibility = 'hidden';
    dom.fire('visibilitychange');
    expect(dom.beacons).toHaveLength(1);
    expect(dom.beacons[0]!.url).toBe('/_hypdriv/vitals');
    expect(JSON.parse(dom.beacons[0]!.body)).toEqual([
      {
        name: 'LCP',
        value: 1800,
        rating: 'good',
        id: 'v4-1',
        pathname: '/blog/hello',
        ts: expect.any(Number),
        delta: 1800,
        navigationType: 'navigate',
        attribution: { element: 'img' },
        route: 'app:/blog/[slug]',
        buildId: 'b1',
        cache: 'HIT',
        tenant: 't1',
      },
    ]);
    // Metrics reported while hidden leave immediately; timers flush the rest.
    reporter.report({ name: 'CLS', value: 0.3, id: 'v4-2' });
    expect(dom.beacons).toHaveLength(2);
    expect(JSON.parse(dom.beacons[1]!.body)[0]).toMatchObject({ name: 'CLS', rating: 'poor' });
    dom.visibility = 'visible';
    reporter.report({ name: 'TTFB', value: 100, id: 'v4-3' });
    expect(dom.beacons).toHaveLength(2);
    vi.advanceTimersByTime(3000);
    expect(dom.beacons).toHaveLength(3);
    reporter.stop();
    expect(dom.listeners.get('pagehide')).toEqual([]);
  });

  it('falls back to fetch keepalive, strips attribution when disabled and honours endpoint/sampleRate', async () => {
    const dom = installDom();
    dom.beaconResult = false;
    const reporter = createVitalsReporter({ endpoint: 'https://collect.test/v', attribution: false });
    reporter.report({ name: 'INP', value: 40, id: 'i1', attribution: { target: 'button' } });
    reporter.flush();
    expect(dom.fetches).toHaveLength(1);
    expect(dom.fetches[0]!.url).toBe('https://collect.test/v');
    expect(dom.fetches[0]!.init).toMatchObject({
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'text/plain' },
    });
    expect(JSON.parse(String(dom.fetches[0]!.init.body))[0].attribution).toBeUndefined();

    const sampledOut = createVitalsReporter({ sampleRate: 0 });
    sampledOut.report({ name: 'LCP', value: 1, id: 'z' });
    sampledOut.flush();
    expect(dom.beacons).toHaveLength(1); // only the failed attempt from above
    expect(dom.fetches).toHaveLength(1);
  });

  it('is a no-op outside the browser', () => {
    const reporter = createVitalsReporter();
    reporter.report({ name: 'LCP', value: 1, id: 'z' });
    reporter.flush();
    reporter.stop();
    expect(reportVitals()()).toBeUndefined();
  });
});

describe('reportVitals', () => {
  it('accepts a custom metric source (useReportWebVitals) and flushes on stop', () => {
    const dom = installDom();
    let feed: ((m: { name: string; value: number; id: string }) => void) | undefined;
    const cleanup = vi.fn();
    const stop = reportVitals({
      source: (report) => {
        feed = report;
        return cleanup;
      },
    });
    feed!({ name: 'FCP', value: 900, id: 'f1' });
    expect(dom.beacons).toHaveLength(0);
    stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(dom.beacons).toHaveLength(1);
    expect(JSON.parse(dom.beacons[0]!.body)[0]).toMatchObject({ name: 'FCP', value: 900, rating: 'good' });
  });

  it('uses the PerformanceObserver fallback when asked (TTFB from navigation timing)', () => {
    const dom = installDom();
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        observe() {
          throw new Error('unsupported');
        }
        disconnect() {}
      },
    );
    const stop = reportVitals({ source: 'observer' });
    expect(dom.beacons).toHaveLength(0);
    stop();
    const sent = JSON.parse(dom.beacons[0]!.body) as Array<{ name: string; value: number }>;
    expect(sent.map((m) => m.name)).toEqual(['TTFB', 'CLS']);
    expect(sent[0]!.value).toBe(120);
  });
});
