import { loadSecurity } from '../integrations';
import type { IO } from '../io';
import { readSecret } from '../util/secrets';

/** Header that carries the owner audit token (`HEADER.auditToken` in `@hypdriv/core`). */
export const AUDIT_TOKEN_HEADER = 'x-hypdriv-audit';
/** Vercel's Deployment Protection bypass header (value: `VERCEL_AUTOMATION_BYPASS_SECRET`). */
export const VERCEL_BYPASS_HEADER = 'x-vercel-protection-bypass';
/** Cloudflare Access service-token headers (values: `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`). */
export const CF_ACCESS_ID_HEADER = 'cf-access-client-id';
export const CF_ACCESS_SECRET_HEADER = 'cf-access-client-secret';

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Parses `name: value` header lines (`--header`, `HYPDRIV_ACCESS_HEADERS`: newline-separated lines or a JSON
 * object). Throws on malformed input so a typo never silently sends unauthenticated requests.
 */
export function parseHeaderLines(input: string | string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const list = Array.isArray(input) ? input : [input];
  for (const raw of list) {
    const text = raw.trim();
    if (!text) continue;
    if (text.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('access headers: invalid JSON object');
      }
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!HEADER_NAME.test(name) || typeof value !== 'string')
          throw new Error(`access headers: invalid header "${name}"`);
        out[name.toLowerCase()] = value;
      }
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const colon = line.indexOf(':');
      const name = colon > 0 ? line.slice(0, colon).trim() : '';
      if (!HEADER_NAME.test(name)) throw new Error('access headers: expected "name: value"');
      out[name.toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  return out;
}

/**
 * Headers that get Hypdriv's tooling through a gateway in front of the deployment: Vercel Deployment
 * Protection (`VERCEL_AUTOMATION_BYPASS_SECRET`), Cloudflare Access service tokens (`CF_ACCESS_CLIENT_ID` +
 * `CF_ACCESS_CLIENT_SECRET`), and any other gate through `HYPDRIV_ACCESS_HEADERS` or `--header` (e.g. a WAF
 * rule that requires a secret header). Read from the environment, `.dev.vars`, `.env*` or `vercel pull`'s files;
 * sent to the audited origin only, never logged.
 */
export function accessHeaders(
  root: string,
  env: Record<string, string | undefined>,
  extra: string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  const bypass = readSecret(root, env, 'VERCEL_AUTOMATION_BYPASS_SECRET');
  if (bypass) out[VERCEL_BYPASS_HEADER] = bypass.value;
  const accessId = readSecret(root, env, 'CF_ACCESS_CLIENT_ID');
  const accessSecret = readSecret(root, env, 'CF_ACCESS_CLIENT_SECRET');
  if (accessId && accessSecret) {
    out[CF_ACCESS_ID_HEADER] = accessId.value;
    out[CF_ACCESS_SECRET_HEADER] = accessSecret.value;
  }
  const configured = readSecret(root, env, 'HYPDRIV_ACCESS_HEADERS');
  if (configured) Object.assign(out, parseHeaderLines(configured.value.replace(/\\n/g, '\n')));
  if (extra.length) Object.assign(out, parseHeaderLines(extra));
  return out;
}

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
  /** `--header 'name: value'` values. */
  headers?: string[];
}): Promise<AuditAuth> {
  const secretName = input.secretName ?? 'HYPDRIV_INTERNAL_SECRET';
  // Gateways in front of the deployment (Deployment Protection, Cloudflare Access, WAF gates) are independent
  // of the Hypdriv token, so `--anonymous` keeps them.
  const base = accessHeaders(input.root, input.io.env, input.headers);
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
    : `Requests are unsigned (${auth.reason}); Hypdriv's bot shield and rate limits treat them like any visitor.`;
}
