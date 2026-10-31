/// <reference path="../virtual.d.ts" />

import { development, prerendering } from 'virtual:hypdriv/astro';
import type { MiddlewareHandler } from 'astro';
import { createOnRequest } from './hook';
import { handler } from './runtime';

/**
 * `@hypdriv/astro/middleware` — the Astro middleware the integration registers with `addMiddleware({ order: 'pre' })`.
 * It runs the Hypdriv Drivetrain around every request Astro renders on demand (pages, endpoints, server islands,
 * actions, on-demand error pages, `/_hypdriv/*`). Apps never import it themselves.
 */
export const onRequest: MiddlewareHandler = createOnRequest({ handler, prerendering, development });
