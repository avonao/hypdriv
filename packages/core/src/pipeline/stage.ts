import type { HypContext } from './context';

export type PreResult = Response | undefined | void;

/** One unit of the Drivetrain pipeline (ADR 0005). */
export interface Stage {
  /** Unique, lowercase, dash-separated. Used in `Server-Timing`, config `stages.disable` and logs. */
  readonly name: string;
  /** Runs before Next.js. Returning a `Response` short-circuits the pipeline (post stages still run). */
  pre?(ctx: HypContext): Promise<PreResult> | PreResult;
  /** Runs after Next.js (or after a short-circuit) with the response. */
  post?(ctx: HypContext, response: Response): Promise<Response> | Response;
  /** Needs response body access (HTMLRewriter etc.); the proxy runner skips it. */
  readonly edgeOnly?: boolean;
  /** When false the stage is skipped for Next internal requests (`/_next/*`). Default false. */
  readonly runOnInternal?: boolean;
  /** When false the stage is skipped for RSC payload requests. Default true. */
  readonly runOnRsc?: boolean;
}

/** Helper for defining stages with inference. */
export function defineStage(stage: Stage): Stage {
  if (!/^[a-z][a-z0-9-]*$/.test(stage.name)) throw new TypeError(`Invalid stage name "${stage.name}"`);
  return stage;
}

/** Default order of built-in stages; custom stages without a position run after `observe`. */
export const DEFAULT_STAGE_ORDER = [
  'request-id',
  'maintenance',
  'shield',
  'bots',
  'rate-limit',
  'geo',
  'i18n',
  'flags',
  'redirects',
  'theme',
  'edge-cache',
  'csp',
  'security-headers',
  'early-hints',
  'speculation',
  'html-transforms',
  'skew',
  'observe',
] as const;

export type BuiltinStageName = (typeof DEFAULT_STAGE_ORDER)[number];

/** Sorts stages by the configured order and removes disabled ones. Unknown names keep relative order at the end. */
export function orderStages(
  stages: Stage[],
  options: { order?: string[] | null; disable?: string[] } = {},
): Stage[] {
  const disabled = new Set(options.disable ?? []);
  const order = options.order?.length ? options.order : [...DEFAULT_STAGE_ORDER];
  const rank = new Map(order.map((name, i) => [name, i]));
  const seen = new Set<string>();
  const out: Stage[] = [];
  for (const s of stages) {
    if (disabled.has(s.name) || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (rank.get(a.s.name) ?? order.length + a.i) - (rank.get(b.s.name) ?? order.length + b.i))
    .map(({ s }) => s);
}
