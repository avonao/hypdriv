import { isRscRequest, mergeHeaders } from '../http/headers';
import { isInternalPath } from '../http/url';
import { toError } from '../util/errors';
import type { HypContext } from './context';
import type { Stage } from './stage';

export interface RunPipelineOptions {
  stages: readonly Stage[];
  ctx: HypContext;
  /** Produces the upstream (Next.js) response. Receives the request with forwarded headers applied. */
  next: (request: Request) => Promise<Response>;
  /** Skip `edgeOnly` stages (proxy runner). */
  skipEdgeOnly?: boolean;
  /** Called when a stage throws; return a Response to recover, or rethrow. */
  onStageError?: (
    error: Error,
    stage: Stage,
    phase: 'pre' | 'post',
    ctx: HypContext,
  ) => Response | undefined | Promise<Response | undefined>;
  /** Applies `ctx.responseHeaders` to the final response (default true). */
  applyResponseHeaders?: boolean;
}

export interface PipelineResult {
  response: Response;
  /** Name of the stage that short-circuited, if any. */
  shortCircuitedBy: string | null;
  /** Names of stages that ran in `pre` (in order). */
  ran: string[];
}

/**
 * Runs `pre` stages in order (stopping at the first Response), then the upstream handler,
 * then `post` stages in reverse order, then merges `ctx.responseHeaders`.
 * Each stage's duration is recorded in `ctx.timings` under its name.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  const { ctx } = options;
  const internal = isInternalPath(ctx.url.pathname, ctx.config.cloudflare.internalPathPrefix);
  const rsc = isRscRequest(ctx.request.headers);
  const applicable = options.stages.filter((s) => {
    if (options.skipEdgeOnly && s.edgeOnly) return false;
    if (internal && !s.runOnInternal) return false;
    if (rsc && s.runOnRsc === false) return false;
    return true;
  });

  const ran: string[] = [];
  let response: Response | undefined;
  let shortCircuitedBy: string | null = null;

  for (const stage of applicable) {
    if (!stage.pre) continue;
    const end = ctx.timings.start(stage.name);
    try {
      const result = await stage.pre(ctx);
      ran.push(stage.name);
      if (result instanceof Response) {
        response = result;
        shortCircuitedBy = stage.name;
        end('short-circuit');
        break;
      }
      end();
    } catch (err) {
      end('error');
      const recovered = await options.onStageError?.(toError(err), stage, 'pre', ctx);
      if (recovered) {
        response = recovered;
        shortCircuitedBy = stage.name;
        break;
      }
      throw err;
    }
  }

  if (!response) {
    const end = ctx.timings.start('next');
    const forwarded = buildForwardedRequest(ctx);
    try {
      response = await options.next(forwarded);
      end();
    } catch (err) {
      end('error');
      throw err;
    }
  }

  for (const stage of [...applicable].reverse()) {
    if (!stage.post) continue;
    const end = ctx.timings.start(`${stage.name}.post`);
    try {
      response = await stage.post(ctx, response);
      end();
    } catch (err) {
      end('error');
      const recovered = await options.onStageError?.(toError(err), stage, 'post', ctx);
      if (recovered) response = recovered;
      else throw err;
    }
  }

  if (options.applyResponseHeaders !== false && hasEntries(ctx.responseHeaders)) {
    const headers = new Headers(response.headers);
    mergeHeaders(headers, ctx.responseHeaders);
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return { response, shortCircuitedBy, ran };
}

/** Creates the request Next.js receives: original request with `ctx.requestHeaders` applied. */
export function buildForwardedRequest(ctx: HypContext): Request {
  if (headersEqual(ctx.request.headers, ctx.requestHeaders)) return ctx.request;
  return new Request(ctx.request, { headers: ctx.requestHeaders });
}

function hasEntries(headers: Headers): boolean {
  for (const _ of headers) return true;
  return false;
}

function headersEqual(a: Headers, b: Headers): boolean {
  const ea = [...a.entries()];
  const eb = [...b.entries()];
  if (ea.length !== eb.length) return false;
  for (let i = 0; i < ea.length; i++) {
    if (ea[i]![0] !== eb[i]![0] || ea[i]![1] !== eb[i]![1]) return false;
  }
  return true;
}
