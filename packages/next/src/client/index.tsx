'use client';

import { type ComponentType, type ReactElement, Suspense, lazy, useEffect } from 'react';

export { FlagsProvider, useFlag, useFlags, Flag } from '@hypdriv/flags/react';

export interface VitalsReporterProps {
  endpoint?: string;
  sampleRate?: number;
  attribution?: boolean;
}

/**
 * Reports Core Web Vitals to HypDriv's collector (`/_hypdriv/vitals`). Place it once in the root layout.
 * Uses `@hypdriv/observe/client`, which prefers the `web-vitals` library when installed.
 */
export function VitalsReporter(props: VitalsReporterProps = {}): null {
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import('@hypdriv/observe/client').then((mod) => {
      if (cancelled) return;
      stop = mod.reportVitals({ ...(props.endpoint ? { endpoint: props.endpoint } : {}), ...(props.sampleRate !== undefined ? { sampleRate: props.sampleRate } : {}), ...(props.attribution !== undefined ? { attribution: props.attribution } : {}) });
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [props.endpoint, props.sampleRate, props.attribution]);
  return null;
}

export interface DevToolsProps {
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  hotkey?: string;
  endpoint?: string;
  initialOpen?: boolean;
  /** Render in production too (default: only when `NODE_ENV !== 'production'`). */
  force?: boolean;
}

const LazyDevTools = lazy(() => import('@hypdriv/devtools').then((m) => ({ default: m.HypDrivDevTools as ComponentType<DevToolsProps> })));

/** The HypDriv DevTools HUD, loaded lazily and only outside production unless `force` is set. */
export function HypDrivDevTools(props: DevToolsProps = {}): ReactElement | null {
  const enabled = props.force || process.env.NODE_ENV !== 'production';
  if (!enabled) return null;
  return (
    <Suspense fallback={null}>
      <LazyDevTools {...props} />
    </Suspense>
  );
}

export { useLive, useLiveValue, useLiveRefresh, LiveProvider } from '@hypdriv/live/react';
