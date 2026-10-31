/**
 * Keeps private test deployments on a Cloudflare zone private with two zone rules per prefix, whatever the number
 * of hosts (the Free plan allows five WAF custom rules):
 *
 * - a WAF custom rule that blocks HTTPS requests to the hosts without the `x-hypdriv-gate` header or the
 *   `hypdriv_gate` cookie, and
 * - a Redirect Rule that sends plain HTTP for the hosts to https before anything answers — Workers Static Assets
 *   are served before the Worker (and so before `redirects.forceHttps`), and an HTTP request cannot carry the gate
 *   safely.
 *
 * Shared by `e2e/hosts` and `e2e/cloudflare` provisioning. The gate value is written into the rule expression and
 * never printed.
 */

export interface ZoneRule {
  id?: string;
  description?: string;
  expression: string;
  action: string;
  action_parameters?: unknown;
  enabled?: boolean;
  [key: string]: unknown;
}

interface CfResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

export interface ZoneGateOptions {
  token: string;
  zone: string;
  /** Rule descriptions start with it; every host gated under the same prefix shares the two rules. */
  prefix: string;
  /** Hosts to add (lowercase). */
  hosts: string[];
  gate: string;
  fetch?: typeof fetch;
}

export interface ZoneGateResult {
  /** Every host the rules now cover. */
  hosts: string[];
}

/** Rule descriptions for a prefix. */
export function gateDescriptions(prefix: string): { gate: string; https: string } {
  const marker = `${prefix}: private HypDriv test deployments`;
  return { gate: `${marker} (gate header or cookie)`, https: `${marker} (https)` };
}

/** The hosts an existing rule expression lists (`http.host in {"a" "b"}` or `http.host eq "a"`). */
export function hostsOf(expression: string, gate: string): string[] {
  const list = /http\.host\s+(?:in\s*\{([^}]*)\}|eq\s*("[^"]*"))/.exec(expression);
  const raw = list?.[1] ?? list?.[2] ?? '';
  return [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((h) => h !== gate && h.includes('.'));
}

/** The gate rule for a host list. */
export function gateRule(prefix: string, hosts: string[], gate: string): ZoneRule {
  const inList = hosts.map((h) => `"${h}"`).join(' ');
  return {
    description: gateDescriptions(prefix).gate,
    expression: `(http.host in {${inList}} and ssl and not any(http.request.headers["x-hypdriv-gate"][*] eq "${gate}") and not http.cookie contains "hypdriv_gate=${gate}")`,
    action: 'block',
    enabled: true,
  };
}

/** The plain-HTTP → https redirect rule for a host list. */
export function httpsRule(prefix: string, hosts: string[]): ZoneRule {
  return {
    description: gateDescriptions(prefix).https,
    expression: `(http.host in {${hosts.map((h) => `"${h}"`).join(' ')}} and not ssl)`,
    action: 'redirect',
    action_parameters: {
      from_value: {
        status_code: 308,
        target_url: { expression: 'concat("https://", http.host, http.request.uri.path)' },
        preserve_query_string: true,
      },
    },
    enabled: true,
  };
}

const writable = ({ id: _id, version: _v, last_updated: _u, ref: _r, ...rest }: ZoneRule): ZoneRule => rest;

/** Adds hosts to the prefix's gate and https rules (creating them), keeping every other rule of the zone. */
export async function gateZoneHosts(options: ZoneGateOptions): Promise<ZoneGateResult> {
  const doFetch = options.fetch ?? fetch;
  const api = async <T>(method: string, path: string, body?: unknown): Promise<CfResponse<T>> => {
    const res = await doFetch(`https://api.cloudflare.com/client/v4/zones/${options.zone}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await res.json()) as CfResponse<T>;
  };
  const errors = (r: CfResponse<unknown>) => (r.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ');
  const names = gateDescriptions(options.prefix);

  const firewall = 'rulesets/phases/http_request_firewall_custom/entrypoint';
  const entry = await api<{ rules?: ZoneRule[] }>('GET', firewall);
  const rules = entry.success ? (entry.result.rules ?? []) : [];
  const hosts = new Set(options.hosts.map((h) => h.toLowerCase()));
  for (const r of rules)
    if (r.description === names.gate) for (const h of hostsOf(r.expression, options.gate)) hosts.add(h);
  const list = [...hosts].sort();
  const put = await api('PUT', firewall, {
    rules: [
      ...rules.filter((r) => r.description !== names.gate).map(writable),
      gateRule(options.prefix, list, options.gate),
    ],
  });
  if (!put.success) throw new Error(`gate rule: ${errors(put)}`);

  const redirectPhase = 'rulesets/phases/http_request_dynamic_redirect/entrypoint';
  const current = await api<{ rules?: ZoneRule[] }>('GET', redirectPhase);
  const redirects = current.success ? (current.result.rules ?? []) : [];
  const putRedirect = await api('PUT', redirectPhase, {
    rules: [
      ...redirects.filter((r) => r.description !== names.https).map(writable),
      httpsRule(options.prefix, list),
    ],
  });
  if (!putRedirect.success) throw new Error(`https redirect: ${errors(putRedirect)}`);
  return { hosts: list };
}
