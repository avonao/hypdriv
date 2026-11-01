/**
 * Browser build of `@hypdriv/solid-start/server` (the `browser` export condition). The helpers read the server's
 * request context, which does not exist in the browser: code that reaches them there (a route component on a
 * client-side navigation) sees "outside a request", and the runtime stays out of the client bundle. Call the
 * helpers from server functions instead.
 */
import type { FlagValue } from '@hypdriv/core';
import type { GeoInfo, HypRequestContext, JobHandlerOptions, JobInput } from '@hypdriv/runtime';

export type { GeoInfo, HypRequestContext, JobHandlerOptions, JobInput };

export function hyp(): HypRequestContext | null {
  return null;
}

export function requireHyp(): HypRequestContext {
  throw new Error(
    'hyp(): no Hypdriv request context in the browser; read request facts in a server function ("use server") instead',
  );
}

export function nonce(): string | undefined {
  return undefined;
}

export function flag<T extends FlagValue>(name: string, fallback: T): T;
export function flag(name: string): FlagValue | undefined;
export function flag(_name: string, fallback?: FlagValue): FlagValue | undefined {
  return fallback;
}

export function geo(): Partial<GeoInfo> {
  return {};
}

export function defer(task: () => Promise<unknown>): void {
  void task().catch(() => undefined);
}

export function jobHandler(
  _options: JobHandlerOptions,
  _handler: (input: JobInput) => Promise<Response | unknown>,
): (request: Request) => Promise<Response> {
  return async () => {
    throw new Error('jobHandler(): job endpoints run on the server only');
  };
}
