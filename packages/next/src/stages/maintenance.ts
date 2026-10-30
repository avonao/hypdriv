import {
  defineStage,
  getCookie,
  type HypContext,
  html,
  json,
  type KVNamespaceLike,
  matchesAny,
  memoizeAsync,
  type ResolvedConfig,
  readEnv,
  type Stage,
} from '@hypdriv/core';

export interface MaintenanceState {
  enabled: boolean;
  message?: string;
  until?: string;
}

function parseFlag(value: unknown): MaintenanceState | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return { enabled: value };
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(v)) return { enabled: true };
    if (['0', 'false', 'off', 'no', ''].includes(v)) return { enabled: false };
    try {
      return parseFlag(JSON.parse(value));
    } catch {
      return { enabled: true, message: value };
    }
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return {
      enabled: o.enabled !== false,
      ...(typeof o.message === 'string' ? { message: o.message } : {}),
      ...(typeof o.until === 'string' ? { until: o.until } : {}),
    };
  }
  return null;
}

/** Built-in maintenance page (no external assets, works under the strictest CSP). */
export function renderMaintenancePage(siteName: string, state: MaintenanceState): string {
  const esc = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const message = state.message ?? 'We are performing scheduled maintenance and will be back shortly.';
  const until = state.until
    ? `<p>Expected back: <time datetime="${esc(state.until)}">${esc(state.until)}</time></p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(siteName)} — maintenance</title><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}main{max-width:36rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.5rem 0;opacity:.8}</style></head><body><main><h1>${esc(siteName)} is briefly unavailable</h1><p>${esc(message)}</p>${until}</main></body></html>`;
}

/** Serves a maintenance page when enabled through config, an environment variable or KV. */
export function maintenanceStage(
  config: ResolvedConfig,
  options: { kv?: KVNamespaceLike; now?: () => number } = {},
): Stage | null {
  const m = config.maintenance;
  if (m.enabled === false) return null;
  const kvState = options.kv
    ? memoizeAsync(
        async () => parseFlag(await options.kv!.get(m.kvKey).catch(() => null)),
        10_000,
        options.now,
      )
    : null;

  return defineStage({
    name: 'maintenance',
    runOnInternal: false,
    async pre(ctx: HypContext) {
      let state: MaintenanceState | null =
        m.enabled === true ? { enabled: true } : parseFlag(readEnv(ctx.env, m.envVar));
      if (!state?.enabled && kvState) state = (await kvState.get('state')) ?? state;
      if (!state?.enabled) return;
      if (matchesAny(m.bypassPaths, ctx.url)) return;
      if (m.allowIps.includes(ctx.ip)) return;
      if (m.bypassCookie && getCookie(ctx.request.headers, m.bypassCookie) === (m.bypassCookieValue ?? '1'))
        return;
      ctx.timings.mark('maintenance', 'on');
      const headers = {
        'retry-after': String(m.retryAfterSeconds),
        'cache-control': 'no-store',
        'x-hypdriv-maintenance': '1',
      };
      const wantsJson =
        ctx.url.pathname.startsWith('/api/') ||
        (ctx.request.headers.get('accept') ?? '').includes('application/json');
      if (wantsJson)
        return json(
          {
            error: 'maintenance',
            message: state.message ?? 'Service temporarily unavailable',
            retryAfter: m.retryAfterSeconds,
          },
          { status: m.status, headers },
        );
      return html(m.html ?? renderMaintenancePage(config.site.name, state), { status: m.status, headers });
    },
  });
}
