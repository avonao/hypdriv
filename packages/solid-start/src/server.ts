/**
 * `@hypdriv/solid-start/server` — request helpers for server code below the Drivetrain: API routes (`GET(event)`),
 * server functions (`"use server"`), route `preload`/`createAsync` code while it renders on the server, and
 * middleware. They read the request the pipeline is handling.
 *
 * ```ts
 * import { flag, hyp } from '@hypdriv/solid-start/server';
 * export async function GET() { return Response.json({ id: hyp()?.requestId, hero: flag('newHero', false) }); }
 * ```
 *
 * Route components also render in the browser: call these helpers from a server function that the component
 * invokes. In the browser this entry resolves to stand-ins that report "no request".
 */
export {
  defer,
  flag,
  type GeoInfo,
  geo,
  type HypRequestContext,
  hyp,
  type JobHandlerOptions,
  type JobInput,
  jobHandler,
  nonce,
  requireHyp,
} from '@hypdriv/runtime';
