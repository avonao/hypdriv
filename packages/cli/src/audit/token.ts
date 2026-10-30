import { loadSecurity } from '../integrations';
import type { IO } from '../io';
import { readSecret } from '../util/secrets';

/** Header that carries the owner audit token (`HEADER.auditToken` in `@hypdriv/core`). */
export const AUDIT_TOKEN_HEADER = 'x-hypdriv-audit';
/** Vercel's Deployment Protection bypass header (value: `VERCEL_AUTOMATION_BYPASS_SECRET`). */
export const VERCEL_BYPASS_HEADER = 'x-vercel-protection-bypass';

export interface AuditAuth {
  /** Headers to add to every request to the audited origin (empty when unsigned). */
  headers: Record<string, string>;
  /** Where the secret came from (`environment`, `.dev.vars`, …), `null` when unsigned. */
  source: string | null;
  /** Variable that holds the internal secret. */
  secretName: string;
  /** Why requests are unsigned (`null` when signed). */
  reason: string | null;
}

/**
 * Mints a short-lived `x-hypdriv-audit` token for the audited host from the internal secret
 * (`security.internalAuth.secretEnv`, default `HYPDRIV_INTERNAL_SECRET`) so the bot shield and rate limiter
 * let the owner's audit, benchmark and warm-up traffic through. Unsigned when `anonymous` is set, the
 * secret is unavailable or `@hypdriv/security` is not installed.
 */
export async function auditAuth(input: {
  root: string;
  io: Pick<IO, 'env' | 'date'>;
  base: string;
  secretName?: string;
  anonymous?: boolean;
  ttlSeconds?: number;
}): Promise<AuditAuth> {
  const secretName = input.secretName ?? 'HYPDRIV_INTERNAL_SECRET';
  // Vercel Deployment Protection: the automation bypass lets the audit reach protected preview deployments
  // (independent of the HypDriv token, so `--anonymous` keeps it).
  const bypass = readSecret(input.root, input.io.env, 'VERCEL_AUTOMATION_BYPASS_SECRET');
  const base: Record<string, string> = bypass ? { [VERCEL_BYPASS_HEADER]: bypass.value } : {};
  const unsigned = (reason: string): AuditAuth => ({ headers: base, source: null, secretName, reason });
  if (input.anonymous) return unsigned('--anonymous');
  const secret = readSecret(input.root, input.io.env, secretName);
  if (!secret) return unsigned(`${secretName} is not set (environment, .dev.vars or .env.local)`);
  const security = await loadSecurity();
  if (!security?.signAuditToken) return unsigned('@hypdriv/security does not provide signAuditToken');
  const token = await security.signAuditToken(secret.value, {
    host: new URL(input.base).hostname,
    ttlSeconds: input.ttlSeconds ?? 1800,
    now: input.io.date().getTime(),
  });
  return {
    headers: { ...base, [AUDIT_TOKEN_HEADER]: token },
    source: secret.source,
    secretName,
    reason: null,
  };
}

/** One-line description of the signing state for terminal output. */
export function describeAuditAuth(auth: AuditAuth): string {
  return auth.source
    ? `Requests carry a signed audit token (${auth.secretName} from ${auth.source}); the bot shield and rate limits let them through.`
    : `Requests are unsigned (${auth.reason}); HypDriv's bot shield and rate limits treat them like any visitor.`;
}
