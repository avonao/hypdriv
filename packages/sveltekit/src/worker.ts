import {
  type AppWorkerModule,
  type CreateWorkerOptions,
  createWorker,
  type HypDrivWorker,
} from '@hypdriv/cloudflare';
import type { HypDrivConfig, HypManifest } from '@hypdriv/core';
import { type SvelteKitCsp, withSvelteKitCsp } from './csp';

export interface SvelteKitWorkerOptions
  extends Omit<CreateWorkerOptions, 'next' | 'app' | 'config' | 'manifest'> {
  /** The HypDriv config (the same one the `handle` hook uses). */
  config: HypDrivConfig;
  /** SvelteKit's `csp` option, folded into HypDriv's policy as in the hook. */
  csp?: SvelteKitCsp | null;
  /** The final build manifest. */
  manifest: HypManifest | (() => Promise<{ default: HypManifest } | HypManifest>);
  /** The Worker adapter-cloudflare generated (its default export, or a loader). */
  app: AppWorkerModule['default'] | (() => Promise<AppWorkerModule | AppWorkerModule['default']>);
}

/**
 * `@hypdriv/sveltekit/worker` — the Cloudflare Worker entry for a SvelteKit app: HypDriv's Worker shell
 * (`createWorker` from `@hypdriv/cloudflare`) around the Worker adapter-cloudflare generated. The HypDriv adapter
 * wrapper generates the entry that calls it; the `handle` hook passes through inside it.
 */
export function createSvelteKitWorker(options: SvelteKitWorkerOptions): HypDrivWorker {
  const { config, csp, manifest, app, ...rest } = options;
  return createWorker({
    ...rest,
    config: withSvelteKitCsp(config, csp),
    manifest,
    app: typeof app === 'function' ? app : async () => app,
  });
}
