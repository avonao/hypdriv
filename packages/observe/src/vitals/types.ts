import type { Logger } from '@hypdriv/core';

export type VitalName = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
export type VitalRating = 'good' | 'needs-improvement' | 'poor';

/** One Web Vitals measurement as beaconed by `@hypdriv/observe/client`. Unknown extra fields pass through. */
export interface VitalsPayload {
  name: VitalName;
  value: number;
  rating: VitalRating;
  id: string;
  /** HypDriv route id from `<meta name="hypdriv:route">`. */
  route?: string;
  pathname: string;
  navigationType?: string;
  attribution?: Record<string, unknown>;
  buildId?: string;
  /** Edge cache status of the document (from the `cache` Server-Timing entry). */
  cache?: string;
  /** Client timestamp, epoch ms. */
  ts: number;
  [extra: string]: unknown;
}

export interface VitalsContext {
  ip?: string;
  country?: string;
  ua?: string;
}

export interface VitalsSink {
  write(payload: VitalsPayload, ctx: VitalsContext): void | Promise<void>;
}

export type VitalsLogger = Logger;
