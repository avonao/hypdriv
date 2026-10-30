import {
  defineStage,
  type Logger,
  type RateLimitBindingLike,
  type ResolvedRateLimitPolicy,
  type Stage,
  toError,
} from '@hypdriv/core';
import {
  policyApplies,
  RATE_LIMIT_KEY,
  type RateLimitResult,
  rateLimitedResponse,
  resolveRateLimitKey,
} from '@hypdriv/security';
import { type CheckRateLimitFn, type CheckRateLimitResult, getVercelSdk } from './sdk';
import { type ConfigInput, defaultLogger, resolveInput, warnOnce } from './util';

/** Options of `vercelRateLimitBinding`. */
export interface VercelRateLimitBindingOptions {
  /** The current request (host, client IP); without it `@vercel/firewall` reads the Vercel request context. */
  request?: Request;
  /** Timeout of the WAF check in milliseconds. */
  timeoutMs?: number;
  log?: Logger;
}

const NOT_REGISTERED =
  '@vercel/firewall is not registered: call registerVercelSdk({ checkRateLimit }) in instrumentation.ts or proxy.ts; WAF rate limits are not enforced';

async function checkRule(
  check: CheckRateLimitFn,
  ruleId: string,
  key: string,
  options: { request?: Request; timeoutMs?: number },
): Promise<CheckRateLimitResult> {
  return check(ruleId, {
    rateLimitKey: key,
    ...(options.request ? { request: options.request } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
}

/**
 * A `RateLimitBindingLike` backed by a Vercel WAF rate-limit rule (`@vercel/firewall` `checkRateLimit`, which
 * must be registered with `registerVercelSdk`). `rateLimited` (also a firewall `blocked`) → `{ success: false }`.
 * An unknown rule (`error: 'not-found'`) or a missing SDK is logged once and allows the request: a WAF
 * misconfiguration must not take the application down.
 */
export function vercelRateLimitBinding(
  ruleId: string,
  options: VercelRateLimitBindingOptions = {},
): RateLimitBindingLike {
  const log = options.log ?? defaultLogger();
  return {
    async limit({ key }) {
      const check = getVercelSdk().checkRateLimit;
      if (!check) {
        warnOnce(log, 'vercel-waf:not-registered', NOT_REGISTERED);
        return { success: true };
      }
      const result = await checkRule(check, ruleId, key, options);
      if (result.error === 'not-found') {
        warnOnce(
          log,
          `vercel-waf:not-found:${ruleId}`,
          `vercel WAF: rate-limit rule "${ruleId}" is not configured; allowing requests`,
          {
            rule: ruleId,
          },
        );
        return { success: true };
      }
      return { success: !result.rateLimited };
    },
  };
}

/**
 * The platform-level WAF binding: the HypDriv limiter calls it for policies with `store: 'binding'`, passing
 * keys that start with the policy id (`<policy>|ip=…`). The policy's own rule from
 * `vercel.firewall.rateLimitRules` is used, otherwise the first configured rule. Returns `null` when no rule
 * is configured.
 */
export function vercelRateLimitRouter(
  configInput: ConfigInput,
  options: Omit<VercelRateLimitBindingOptions, 'request'> = {},
): RateLimitBindingLike | null {
  const config = resolveInput(configInput);
  const rules = config.vercel.firewall.rateLimitRules;
  const ids = Object.values(rules);
  if (!ids.length) return null;
  const bindings = new Map<string, RateLimitBindingLike>();
  const bindingFor = (ruleId: string) => {
    let binding = bindings.get(ruleId);
    if (!binding) {
      binding = vercelRateLimitBinding(ruleId, options);
      bindings.set(ruleId, binding);
    }
    return binding;
  };
  return {
    limit({ key }) {
      const policy = key.split('|', 1)[0] ?? '';
      return bindingFor(rules[policy] ?? ids[0]!).limit({ key });
    },
  };
}

/** Options of `vercelRateLimitStage`. */
export interface VercelRateLimitStageOptions {
  /** Timeout of each WAF check in milliseconds (default 2000). */
  timeoutMs?: number;
}

/**
 * The `rate-limit-vercel` stage: for every HypDriv rate-limit policy listed in
 * `vercel.firewall.rateLimitRules` that applies to the request, asks the mapped Vercel WAF rule (with the
 * request, so host and client IP are known) and short-circuits with the policy's 429 response
 * (`rateLimitedResponse` from `@hypdriv/security`, including `Retry-After`) when the WAF limits it. Checks run
 * concurrently; the first limited policy in config order answers. Policies with `store: 'binding'` are skipped
 * because the main `rate-limit` stage already sends them to the WAF through the platform binding. WAF errors
 * fail open (logged). Returns `null` when no configured policy is mapped to a rule.
 */
export function vercelRateLimitStage(
  configInput: ConfigInput,
  options: VercelRateLimitStageOptions = {},
): Stage | null {
  const config = resolveInput(configInput);
  const rules = config.vercel.firewall.rateLimitRules;
  const mapped: Array<{ policy: ResolvedRateLimitPolicy; rule: string }> = [];
  for (const policy of config.security.rateLimit) {
    const rule = rules[policy.id];
    if (rule && policy.store !== 'binding') mapped.push({ policy, rule });
  }
  if (!mapped.length) return null;
  const timeoutMs = options.timeoutMs ?? 2000;

  return defineStage({
    name: 'rate-limit-vercel',
    async pre(ctx) {
      const applicable = mapped.filter(({ policy }) => policyApplies(policy, ctx));
      if (!applicable.length) return;
      const check = getVercelSdk().checkRateLimit;
      if (!check) {
        warnOnce(ctx.log, 'vercel-waf:not-registered', NOT_REGISTERED);
        return;
      }
      const now = Date.now();
      const results = await Promise.all(
        applicable.map(async ({ policy, rule }) => {
          try {
            return await checkRule(check, rule, resolveRateLimitKey(policy, ctx), {
              request: ctx.request,
              timeoutMs,
            });
          } catch (error) {
            ctx.log.error('vercel WAF rate-limit check failed; allowing request', {
              policy: policy.id,
              rule,
              error: toError(error).message,
            });
            return null;
          }
        }),
      );
      for (let i = 0; i < applicable.length; i++) {
        const { policy, rule } = applicable[i]!;
        const result = results[i];
        if (!result) continue;
        if (result.error === 'not-found') {
          warnOnce(
            ctx.log,
            `vercel-waf:not-found:${rule}`,
            `vercel WAF: rate-limit rule "${rule}" is not configured; allowing requests`,
            {
              rule,
              policy: policy.id,
            },
          );
          continue;
        }
        if (!result.rateLimited) continue;
        const window = policy.windowSeconds;
        const limited: RateLimitResult = {
          allowed: false,
          limit: policy.limit,
          remaining: 0,
          resetAt: now + window * 1000,
          retryAfter: Math.max(1, Math.ceil(window)),
          window,
        };
        const entries = [...(ctx.state.get(RATE_LIMIT_KEY) ?? [])];
        entries.push({ policy: policy.id, remaining: 0, limit: policy.limit, reset: limited.resetAt });
        ctx.state.set(RATE_LIMIT_KEY, entries);
        ctx.timings.mark('limit', policy.id);
        ctx.log.warn('rate limit exceeded (Vercel WAF)', {
          policy: policy.id,
          rule,
          blocked: result.error === 'blocked',
        });
        return rateLimitedResponse(policy, limited, now);
      }
    },
  });
}
