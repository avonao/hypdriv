/// <reference types="@hypdriv/vite/virtual" />

// Build-time constants Nitro replaces in server bundles (Nitro 2 and Nitro 3 define the same ones).
interface ImportMeta {
  readonly dev: boolean;
  readonly prerender: boolean;
  readonly _websocket?: boolean;
}

declare module '#hypdriv/options' {
  /** See `NitroRuntimeOptions` in `./options`. */
  const options: {
    target?: 'cloudflare' | 'vercel' | 'node';
    host: string;
    assetPrefixes: string[];
    nonce: boolean;
    socketIp: boolean;
  };
  export default options;
}

declare module '#hypdriv/cloudflare-exports' {}

declare module '#nitro-internal-pollyfills' {}

declare module '#nitro-internal-virtual/public-assets' {
  export function isPublicAssetURL(id?: string): boolean;
}

declare module 'nitropack/presets/cloudflare/runtime/_module-handler' {
  export interface NitroWorkerHandler {
    fetch(request: Request, env: Record<string, unknown>, context: unknown): Promise<Response>;
    scheduled(controller: unknown, env: Record<string, unknown>, context: unknown): void;
    email(message: unknown, env: Record<string, unknown>, context: unknown): void;
    queue(batch: unknown, env: Record<string, unknown>, context: unknown): void;
    tail(traces: unknown, env: Record<string, unknown>, context: unknown): void;
    trace(traces: unknown, env: Record<string, unknown>, context: unknown): void;
  }
  export function createHandler(hooks: {
    fetch?: (
      request: Request,
      env: Record<string, unknown>,
      context: unknown,
      url: URL,
      ctxExt: Record<string, unknown>,
    ) => Promise<Response | undefined> | Response | undefined;
  }): NitroWorkerHandler;
}

declare module 'crossws/adapters/cloudflare' {
  const adapter: (hooks: unknown) => {
    handleUpgrade(request: Request, env: unknown, context: unknown): Promise<Response>;
  };
  export default adapter;
}
