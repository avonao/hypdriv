import type { ResolvedConfig } from '../config/resolved';
import { type Logger, silentLogger } from '../logger';
import { emptyManifest, type HypManifest, type RouteMatch } from '../manifest/types';
import { createRequestId } from '../util/id';
import { detectRuntime, type RuntimeKind } from '../util/runtime';
import { Timings } from './timing';

/** Subset of Cloudflare's `request.cf` that HypDriv reads. All fields optional: other platforms have none. */
export interface GeoProperties {
  country?: string;
  region?: string;
  regionCode?: string;
  city?: string;
  continent?: string;
  postalCode?: string;
  timezone?: string;
  latitude?: string;
  longitude?: string;
  colo?: string;
  asn?: number;
  asOrganization?: string;
  isEUCountry?: string;
  httpProtocol?: string;
  tlsVersion?: string;
  clientTrustScore?: number;
  botManagement?: {
    score?: number;
    verifiedBot?: boolean;
    staticResource?: boolean;
    jsDetection?: { passed?: boolean };
    detectionIds?: number[];
  };
  verifiedBotCategory?: string;
  [key: string]: unknown;
}

/** Typed key for the per-request state bag. */
export interface StateKey<T> {
  readonly name: string;
  readonly __type?: T;
}

export function stateKey<T>(name: string): StateKey<T> {
  return { name };
}

export class StateBag {
  private readonly map = new Map<string, unknown>();
  get<T>(key: StateKey<T>): T | undefined {
    return this.map.get(key.name) as T | undefined;
  }
  set<T>(key: StateKey<T>, value: T): void {
    this.map.set(key.name, value);
  }
  has<T>(key: StateKey<T>): boolean {
    return this.map.has(key.name);
  }
  delete<T>(key: StateKey<T>): void {
    this.map.delete(key.name);
  }
  /** Snapshot for DevTools; values are not cloned. */
  entries(): Array<[string, unknown]> {
    return [...this.map.entries()];
  }
}

export type Runner = 'worker' | 'proxy' | 'node' | 'test';

export interface HypContext {
  readonly request: Request;
  readonly url: URL;
  readonly id: string;
  readonly runtime: RuntimeKind;
  readonly runner: Runner;
  readonly env: Record<string, unknown>;
  readonly cf: GeoProperties | undefined;
  readonly manifest: HypManifest;
  readonly config: ResolvedConfig;
  readonly state: StateBag;
  readonly timings: Timings;
  readonly signal: AbortSignal;
  readonly development: boolean;
  /** Headers forwarded to Next.js (nonce, geo, flags...). Stages add to them in `pre`. */
  readonly requestHeaders: Headers;
  /** Headers merged into the final response after all `post` stages ran. */
  readonly responseHeaders: Headers;
  route: RouteMatch | null;
  log: Logger;
  waitUntil(promise: Promise<unknown>): void;
  /** Client IP as determined by the runner. */
  readonly ip: string;
}

export interface CreateContextOptions {
  request: Request;
  config: ResolvedConfig;
  manifest?: HypManifest | null;
  env?: Record<string, unknown>;
  cf?: GeoProperties;
  runner?: Runner;
  waitUntil?: (promise: Promise<unknown>) => void;
  log?: Logger;
  development?: boolean;
  ip?: string;
  route?: RouteMatch | null;
  id?: string;
}

/** Creates the per-request context shared by every stage. */
export function createContext(options: CreateContextOptions): HypContext {
  const url = new URL(options.request.url);
  const pending: Promise<unknown>[] = [];
  const waitUntil =
    options.waitUntil ??
    ((p: Promise<unknown>) => {
      pending.push(p.catch(() => undefined));
    });
  const ctx: HypContext & { pending: Promise<unknown>[] } = {
    request: options.request,
    url,
    id: options.id ?? options.request.headers.get('x-hypdriv-request-id') ?? createRequestId(),
    runtime: detectRuntime(),
    runner: options.runner ?? 'test',
    env: options.env ?? {},
    cf: options.cf,
    manifest: options.manifest ?? emptyManifest(),
    config: options.config,
    state: new StateBag(),
    timings: new Timings(),
    signal: options.request.signal,
    development: options.development ?? false,
    requestHeaders: new Headers(options.request.headers),
    responseHeaders: new Headers(),
    route: options.route ?? null,
    log: options.log ?? silentLogger,
    waitUntil,
    ip: options.ip ?? '0.0.0.0',
    pending,
  };
  return ctx;
}

/** Awaits background work registered through the default `waitUntil` (tests and Node runner). */
export async function flushContext(ctx: HypContext): Promise<void> {
  const pending = (ctx as HypContext & { pending?: Promise<unknown>[] }).pending;
  if (!pending) return;
  while (pending.length) {
    const batch = pending.splice(0, pending.length);
    await Promise.allSettled(batch);
  }
}
