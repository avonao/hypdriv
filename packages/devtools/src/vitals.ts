import {
  type RscNavigation,
  rateVital,
  rscNavigationFromEntry,
  type VitalName,
  type VitalSample,
} from './readers';

type Listener = (sample: VitalSample) => void;

interface ObserverLike {
  observe(options: { type: string; buffered?: boolean; durationThreshold?: number }): void;
  disconnect(): void;
}
type ObserverCtor = new (callback: (list: { getEntries(): unknown[] }) => void) => ObserverLike;

function observerCtor(): ObserverCtor | null {
  const ctor = (globalThis as { PerformanceObserver?: ObserverCtor }).PerformanceObserver;
  return typeof ctor === 'function' ? ctor : null;
}

function observe(
  type: string,
  callback: (entries: unknown[]) => void,
  extra: { durationThreshold?: number } = {},
): (() => void) | null {
  const Ctor = observerCtor();
  if (!Ctor) return null;
  try {
    const po = new Ctor((list) => callback(list.getEntries()));
    po.observe({ type, buffered: true, ...extra });
    return () => po.disconnect();
  } catch {
    return null; // entry type unsupported in this browser
  }
}

/**
 * Subscribes to LCP, CLS, INP (approximated from Event Timing: the largest interaction duration, which
 * tracks the p98 closely for the handful of interactions a dev session has), and FCP via
 * `PerformanceObserver`. Returns an unsubscribe function. Values are provisional while the page lives.
 */
export function observeVitals(listener: Listener): () => void {
  const stops: Array<() => void> = [];
  const emit = (name: VitalName, value: number, provisional: boolean) =>
    listener({ name, value, rating: rateVital(name, value), provisional });

  const lcp = observe('largest-contentful-paint', (entries) => {
    const last = entries.at(-1) as { startTime?: number; renderTime?: number; loadTime?: number } | undefined;
    if (!last) return;
    const value = last.renderTime || last.loadTime || last.startTime || 0;
    if (value > 0) emit('LCP', value, true);
  });
  if (lcp) stops.push(lcp);

  let cls = 0;
  const shift = observe('layout-shift', (entries) => {
    let changed = false;
    for (const e of entries as Array<{ hadRecentInput?: boolean; value?: number }>) {
      if (e.hadRecentInput || typeof e.value !== 'number') continue;
      cls += e.value;
      changed = true;
    }
    if (changed || cls === 0) emit('CLS', cls, true);
  });
  if (shift) stops.push(shift);

  let inp = 0;
  const event = observe(
    'event',
    (entries) => {
      let changed = false;
      for (const e of entries as Array<{ interactionId?: number; duration?: number }>) {
        if (!e.interactionId || typeof e.duration !== 'number') continue;
        if (e.duration > inp) {
          inp = e.duration;
          changed = true;
        }
      }
      if (changed) emit('INP', inp, true);
    },
    { durationThreshold: 16 },
  );
  if (event) stops.push(event);

  const paint = observe('paint', (entries) => {
    for (const e of entries as Array<{ name?: string; startTime?: number }>) {
      if (e.name === 'first-contentful-paint' && typeof e.startTime === 'number')
        emit('FCP', e.startTime, false);
    }
  });
  if (paint) stops.push(paint);

  return () => {
    for (const stop of stops) stop();
  };
}

/** Watches resource timings for RSC payload fetches (client-side navigations). */
export function observeRscNavigations(listener: (navigation: RscNavigation) => void): () => void {
  const stop = observe('resource', (entries) => {
    for (const entry of entries) {
      const nav = rscNavigationFromEntry(entry as Parameters<typeof rscNavigationFromEntry>[0]);
      if (nav) listener(nav);
    }
  });
  return stop ?? (() => undefined);
}
