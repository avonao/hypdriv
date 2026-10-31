/**
 * `@hypdriv/astro/server` — HypDriv's request helpers for Astro pages, layouts, components, endpoints, server
 * islands and actions. They read the request context the HypDriv middleware (or the Cloudflare Worker shell)
 * installs, so they work anywhere below it during a request and return `null`/defaults during build-time
 * prerendering.
 *
 * ```astro
 * ---
 * import { hyp, flag } from '@hypdriv/astro/server';
 * const ctx = hyp();
 * const newHero = flag('newHero', false);
 * ---
 * <script nonce={ctx?.nonce}>…</script>
 * ```
 */
import { type JobHandlerOptions, type JobInput, jobHandler } from '@hypdriv/runtime';

export {
  createJobHandler,
  defer,
  flag,
  geo,
  type HypRequestContext,
  hyp,
  type JobHandlerHost,
  type JobHandlerOptions,
  type JobInput,
  jobHandler,
  nonce,
  requireHyp,
} from '@hypdriv/runtime';

/**
 * `jobHandler()` shaped as an Astro endpoint: accepts only HypDriv's signed job dispatch (Cloudflare `scheduled` /
 * `queue` through the Worker shell, `hypdriv jobs run`) and Vercel Cron calls carrying `CRON_SECRET`.
 *
 * ```ts
 * // src/pages/api/jobs/[job].ts
 * import { jobRoute } from '@hypdriv/astro/server';
 * export const prerender = false;
 * export const POST = jobRoute({}, async ({ job, payload }) => ({ job, payload }));
 * export const GET = POST; // Vercel Cron calls with GET
 * ```
 */
export function jobRoute(
  options: JobHandlerOptions,
  handler: (input: JobInput) => Promise<Response | unknown>,
): (context: { request: Request }) => Promise<Response> {
  const handle = jobHandler(options, handler);
  return (context) => handle(context.request);
}
