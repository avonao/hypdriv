import { clientIp, type Logger, toError } from '@hypdriv/core';
import type { VitalName, VitalRating, VitalsContext, VitalsPayload, VitalsSink } from './types';

const NAMES: ReadonlySet<string> = new Set<VitalName>(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']);
const RATINGS: ReadonlySet<string> = new Set<VitalRating>(['good', 'needs-improvement', 'poor']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SHORT = 256;
const MAX_PATH = 2048;

/** web.dev thresholds (good / poor) per metric. */
export const VITALS_THRESHOLDS: Record<VitalName, [good: number, poor: number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

/** Rates a metric value with the standard thresholds. */
export function rateVital(name: VitalName, value: number): VitalRating {
  const [good, poor] = VITALS_THRESHOLDS[name];
  if (value <= good) return 'good';
  return value <= poor ? 'needs-improvement' : 'poor';
}

function shortString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_SHORT) : undefined;
}

/** Validates and normalises one beacon entry; returns null when it is not a usable measurement. */
export function normalizeVitalsPayload(input: unknown, now: number = Date.now()): VitalsPayload | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.toUpperCase() : '';
  if (!NAMES.has(name)) return null;
  const value = typeof raw.value === 'number' ? raw.value : Number(raw.value);
  if (!Number.isFinite(value) || value < 0) return null;
  const id = shortString(raw.id);
  if (!id) return null;
  const pathname =
    typeof raw.pathname === 'string' && raw.pathname.startsWith('/') ? raw.pathname.slice(0, MAX_PATH) : null;
  if (!pathname) return null;
  const rating =
    typeof raw.rating === 'string' && RATINGS.has(raw.rating)
      ? (raw.rating as VitalRating)
      : rateVital(name as VitalName, value);
  const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) && raw.ts > 0 ? raw.ts : now;

  const out: VitalsPayload = { name: name as VitalName, value, rating, id, pathname, ts };
  const route = shortString(raw.route);
  if (route) out.route = route;
  const navigationType = shortString(raw.navigationType);
  if (navigationType) out.navigationType = navigationType;
  const buildId = shortString(raw.buildId);
  if (buildId) out.buildId = buildId;
  const cache = shortString(raw.cache);
  if (cache) out.cache = cache;
  if (raw.attribution && typeof raw.attribution === 'object' && !Array.isArray(raw.attribution)) {
    const attribution: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.attribution as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      attribution[k] = typeof v === 'string' ? v.slice(0, MAX_PATH) : v;
    }
    out.attribution = attribution;
  }
  const known = new Set([
    'name',
    'value',
    'rating',
    'id',
    'route',
    'pathname',
    'navigationType',
    'attribution',
    'buildId',
    'cache',
    'ts',
    'delta',
  ]);
  for (const [k, v] of Object.entries(raw)) {
    if (known.has(k) || FORBIDDEN_KEYS.has(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, MAX_SHORT);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[k] = v;
  }
  if (typeof raw.delta === 'number' && Number.isFinite(raw.delta)) out.delta = raw.delta;
  return out;
}

export interface VitalsHandlerOptions {
  sink: VitalsSink;
  /** Share of beacons written to the sink, 0..1 (default 1; decided per beacon, not per metric). */
  sampleRate?: number;
  /** Max request body in bytes (default 64 KB). */
  maxBytes?: number;
  /** Max metrics per beacon (default 32). */
  maxMetrics?: number;
  /** `Access-Control-Allow-Origin` value (`*` or a comma-separated allow-list); enables CORS preflight. */
  allowOrigin?: string;
  log?: Logger;
  random?: () => number;
  now?: () => number;
}

async function readText(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function corsHeaders(allowOrigin: string | undefined, request: Request): Record<string, string> {
  if (!allowOrigin) return {};
  const origin = request.headers.get('origin');
  let allow: string | null = null;
  if (allowOrigin === '*') allow = '*';
  else if (origin) {
    const list = allowOrigin
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    if (list.includes(origin)) allow = origin;
  }
  if (!allow) return {};
  const headers: Record<string, string> = {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
  if (allow !== '*') headers.vary = 'Origin';
  return headers;
}

function respond(status: number, headers: Record<string, string>, body?: string): Response {
  return new Response(body ?? null, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
  });
}

/**
 * The `/_hypdriv/vitals` beacon endpoint: accepts one payload or an array (JSON, also as
 * `text/plain` from `navigator.sendBeacon`), validates and bounds it, samples per beacon, writes
 * through the sink and answers `204` with `cache-control: no-store`. Handles CORS preflight when
 * `allowOrigin` is set.
 */
export function vitalsHandler(
  options: VitalsHandlerOptions,
): (request: Request, ctx?: VitalsContext) => Promise<Response> {
  const sampleRate = Math.min(1, Math.max(0, options.sampleRate ?? 1));
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const maxMetrics = Math.max(1, options.maxMetrics ?? 32);
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  return async (request, ctx) => {
    const cors = corsHeaders(options.allowOrigin, request);
    if (request.method === 'OPTIONS') return respond(204, { ...cors, allow: 'POST, OPTIONS' });
    if (request.method !== 'POST') return respond(405, { ...cors, allow: 'POST, OPTIONS' });
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return respond(413, cors);
    const text = await readText(request, maxBytes);
    if (text === null) return respond(413, cors);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return respond(400, cors, '{"error":"invalid_json"}');
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length === 0 || list.length > maxMetrics)
      return respond(400, cors, '{"error":"invalid_payload"}');
    const t = now();
    const payloads = list
      .map((p) => normalizeVitalsPayload(p, t))
      .filter((p): p is VitalsPayload => p !== null);
    if (!payloads.length) return respond(400, cors, '{"error":"invalid_payload"}');

    if (sampleRate > 0 && (sampleRate >= 1 || random() < sampleRate)) {
      const vctx: VitalsContext = {
        ip: ctx?.ip ?? clientIp(request.headers),
        country: ctx?.country ?? request.headers.get('cf-ipcountry') ?? undefined,
        ua: ctx?.ua ?? request.headers.get('user-agent') ?? undefined,
      };
      for (const payload of payloads) {
        try {
          await options.sink.write(payload, vctx);
        } catch (err) {
          options.log?.warn('vitals: sink failed', { error: toError(err).message, metric: payload.name });
        }
      }
    }
    return respond(204, cors);
  };
}
