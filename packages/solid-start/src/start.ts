import { nonce as requestNonce } from '@hypdriv/runtime';

/** The render options SolidStart's `createHandler(fn, options)` takes that Hypdriv reads or sets. */
export interface StartRenderOptions {
  /** The CSP nonce Solid stamps on the inline scripts it renders (`HydrationScript`, streamed chunks, redirects). */
  nonce?: string | undefined;
  [option: string]: unknown;
}

/**
 * The render options for `createHandler()` in `src/entry-server.tsx`: hands the request's CSP nonce (nonce mode) to
 * Solid, so its hydration script, the serialised-resource scripts it streams and the client redirect it writes after
 * the shell all carry the nonce the response's `Content-Security-Policy` allows.
 *
 * ```tsx
 * import { hypdrivStart } from '@hypdriv/solid-start';
 * export default createHandler(() => <StartServer document={…} />, hypdrivStart());
 * ```
 *
 * Without it the CSP stage still nonces every `<script>` of the streamed HTML (a streaming rewrite of the response:
 * `HTMLRewriter` on Workers, a portable tokenizer elsewhere); with it Solid renders the nonce itself and the rewrite
 * finds nothing left to do. Other render options (`mode`, `onCompleteAll`, …) pass through; a function receives
 * SolidStart's page event.
 */
export function hypdrivStart<Context = unknown, Options extends StartRenderOptions = StartRenderOptions>(
  options?: Options | ((context: Context) => Options | Promise<Options>),
): (context: Context) => Promise<Options & { nonce?: string | undefined }> {
  return async (context) => {
    const resolved = (typeof options === 'function' ? await options(context) : (options ?? {})) as Options;
    const current = requestNonce();
    return (
      current && resolved.nonce === undefined ? { ...resolved, nonce: current } : resolved
    ) as Options & {
      nonce?: string | undefined;
    };
  };
}
