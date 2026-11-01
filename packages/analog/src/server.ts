/**
 * Server-side helpers for Analog applications: the request context Hypdriv's pipeline created for the request being
 * served (an API route in `src/server/routes`, a page endpoint `*.server.ts`, or the Angular render itself).
 *
 * ```ts
 * // src/server/routes/api/hello.ts
 * import { defineEventHandler } from 'h3';
 * import { flag, hyp } from '@hypdriv/analog/server';
 *
 * export default defineEventHandler(() => ({ requestId: hyp()?.requestId, hero: flag('newHero', false) }));
 * ```
 */
export * from '@hypdriv/nitro/server';
