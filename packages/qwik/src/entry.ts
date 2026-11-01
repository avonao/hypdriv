import { getCurrentContext, type HypDrivConfig, type ResolvedConfig } from '@hypdriv/core';
import {
  type CreateHandlerOptions,
  createHandler,
  type HypHandler,
  type ManifestSource,
} from '@hypdriv/runtime';
import type { ClientConn } from '@qwik.dev/router/middleware/request-handler';

/** The label reported in logs and `/_hypdriv/health`. */
export const HOST_LABEL = 'qwik';

/**
 * Hypdriv's options in a Qwik entry (`createQwikRouter({ render, hypdriv: { … } })`). The config and the manifest
 * come from the Hypdriv Vite plugin (`hypdriv.config.ts`, `.hypdriv/manifest`) unless given here.
 */
export interface HypDrivRuntimeOptions extends Omit<CreateHandlerOptions, 'config' | 'manifest' | 'host'> {
  config?: HypDrivConfig | ResolvedConfig;
  manifest?: ManifestSource;
  /** The framework label (default `qwik`). */
  host?: string;
}

/** What a platform wrapper needs: the plugin's modules plus the application's own options. */
export interface WrapOptions extends HypDrivRuntimeOptions {
  config: HypDrivConfig | ResolvedConfig;
  manifest: ManifestSource;
}

/** The handler of an entry: `createHandler({ runner: 'host' })` with the Qwik label. */
export function handlerFor(options: WrapOptions): HypHandler {
  const { config, manifest, host, ...rest } = options;
  return createHandler({ ...rest, config, manifest, host: host ?? HOST_LABEL });
}

/** An IPv4-mapped IPv6 address (`::ffff:203.0.113.9`, what a dual-stack Node socket reports) as plain IPv4. */
export function plainAddress(address: string): string {
  return /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1] ?? address;
}

/**
 * The client facts for Qwik's `requestEv.clientConn`: what the Drivetrain resolved for the request (trusted
 * proxies, `CF-Connecting-IP`, Vercel's forwarded address, the socket), else the platform's own header.
 */
export function clientConnFor(
  request: Request,
  platformHeaders: { ip: string; country: string },
): ClientConn {
  const context = getCurrentContext();
  const ip = context?.ip || request.headers.get(platformHeaders.ip) || undefined;
  const country = context?.cf?.country || request.headers.get(platformHeaders.country) || undefined;
  return { ...(ip ? { ip } : {}), ...(country ? { country } : {}) };
}

/** The pipeline's `upstream` for a Qwik fetch: Qwik's answer, or the not-found response when no route matches. */
export type QwikUpstream = (request: Request) => Promise<Response>;
