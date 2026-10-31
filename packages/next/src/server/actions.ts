import { clientIp, HEADER } from '@hypdriv/core';
import { decodeGeoHeader } from '@hypdriv/runtime';
import { defineRoute as baseDefineRoute, safeAction as baseSafeAction } from '@hypdriv/security';

type BaseSafeAction = typeof baseSafeAction;
type BaseDefineRoute = typeof baseDefineRoute;

/** Context Hypdriv provides to `safeAction` handlers in Next.js. */
export interface ServerActionContext {
  requestId: string | null;
  ip: string;
  country: string | null;
  headers: Headers;
}

async function nextContext(): Promise<ServerActionContext> {
  const mod = (await import('next/headers')) as { headers(): Promise<Headers> | Headers };
  const headers = new Headers(await mod.headers());
  return {
    requestId: headers.get(HEADER.hypRequestId),
    ip: clientIp(headers),
    country: decodeGeoHeader(headers.get(HEADER.geo))?.country ?? headers.get('cf-ipcountry'),
    headers,
  };
}

/**
 * `safeAction` from `@hypdriv/security` with the Next.js request context injected (request id, client IP,
 * country and headers from `next/headers`).
 */
export const safeAction: BaseSafeAction = ((definition: Parameters<BaseSafeAction>[0]) =>
  baseSafeAction({
    ...definition,
    getContext: definition.getContext ?? nextContext,
  } as Parameters<BaseSafeAction>[0])) as BaseSafeAction;

/** `defineRoute` re-exported for Route Handlers (`export const GET = defineRoute({...})`). */
export const defineRoute: BaseDefineRoute = baseDefineRoute;
