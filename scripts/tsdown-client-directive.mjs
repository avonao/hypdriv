/**
 * Keeps Next.js Client Component boundaries intact in the published bundles.
 *
 * Rolldown warns (`MODULE_LEVEL_DIRECTIVE`) that a module-level `'use client'` may not survive bundling, for
 * every module that has one. For HypDriv's packages the directive must sit at the top of the entry chunk of
 * each client entry (`@hypdriv/next/client`, `hypdriv/client`, `@hypdriv/flags/react`, …), so this plugin
 * guarantees exactly that and turns every other placement into a build error:
 *
 * - an entry chunk whose entry module declares `'use client'` starts with the directive (added if the
 *   bundler dropped it);
 * - a chunk that contains a client module without being such an entry fails the build, since silently
 *   dropping the boundary (or adding it to code a server entry imports) would change semantics.
 *
 * With that guarantee the generic warning is noise, so `quietClientDirective` filters it (other directives and
 * logs pass through).
 */

const DIRECTIVE = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*(['"])use client\1;?/;

/** @returns {import('rolldown').Plugin} */
export function clientDirectivePlugin() {
  const clientModules = new Set();
  return {
    name: 'hypdriv:use-client',
    transform: {
      order: 'pre',
      handler(code, id) {
        if (DIRECTIVE.test(code)) clientModules.add(id);
        return null;
      },
    },
    renderChunk(code, chunk) {
      const clientIds = chunk.moduleIds.filter((id) => clientModules.has(id));
      if (!clientIds.length) return null;
      const entryIsClient = chunk.isEntry && chunk.facadeModuleId && clientModules.has(chunk.facadeModuleId);
      if (!entryIsClient)
        this.error(
          `'use client' module(s) ${clientIds.join(', ')} ended up in chunk ${chunk.fileName}, which is not the entry chunk of a client entry: the Client Component boundary would be lost`,
        );
      if (DIRECTIVE.test(code)) return null;
      return { code: `'use client';\n${code}`, map: null };
    },
  };
}

/** `inputOptions.onLog`: drops rolldown's `MODULE_LEVEL_DIRECTIVE` warning for `'use client'` only. */
export function quietClientDirective(level, log, handler) {
  if (log.code === 'MODULE_LEVEL_DIRECTIVE' && /"use client"/.test(log.message ?? '')) return;
  handler(level, log);
}
