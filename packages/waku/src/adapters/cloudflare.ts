/// <reference path="../../virtual.d.ts" />
import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import wakuCloudflare from 'waku/adapters/cloudflare';
import { type CloudflareWrapOptions, wrapCloudflareEntry } from '../cloudflare';

type Handlers = Parameters<typeof wakuCloudflare>[0];
type WakuCloudflareOptions = NonNullable<Parameters<typeof wakuCloudflare>[1]>;

/** Waku's Cloudflare adapter options, plus Hypdriv's under `hypdriv`. */
export type HypDrivCloudflareOptions = WakuCloudflareOptions & {
  hypdriv?: Omit<CloudflareWrapOptions, 'config' | 'manifest' | 'internalPathToBuildStaticFiles'> &
    Partial<Pick<CloudflareWrapOptions, 'config' | 'manifest'>>;
};

/**
 * Waku's Cloudflare adapter (`waku/adapters/cloudflare`) behind Hypdriv's Worker shell: the Worker's default export
 * is `createWorker()` around Waku's, so the Drivetrain (with `HTMLRewriter`), `/_hypdriv/*`, Durable Object stores
 * and the `scheduled` / `queue` / `email` job handlers run in front of everything the Worker receives. The
 * application's own `handlers` option keeps working next to them.
 */
export default function adapter(handlers: Handlers, options?: HypDrivCloudflareOptions) {
  const { hypdriv, ...waku } = options ?? {};
  return wrapCloudflareEntry(wakuCloudflare(handlers, waku), {
    config,
    manifest,
    ...(waku.internalPathToBuildStaticFiles
      ? { internalPathToBuildStaticFiles: waku.internalPathToBuildStaticFiles }
      : {}),
    ...hypdriv,
  });
}
