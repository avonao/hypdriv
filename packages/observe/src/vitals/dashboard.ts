import { VITALS_THRESHOLDS } from './handler';
import { formatVital, VITAL_LABELS, VITAL_NAMES } from './stats';
import type { VitalName, VitalRating, VitalsOverall, VitalsSnapshot, VitalsTrendPoint } from './types';

export interface VitalsDashboardView {
  /** `null` when nothing could be read (see `error` and `notes`). */
  snapshot: VitalsSnapshot | null;
  /** A failed read, shown instead of the numbers. */
  error?: string | null;
  days: number;
  route?: string | null;
  /** Setup hints, one per line (for example which secret is missing for durable storage). */
  notes?: string[];
}

export interface VitalsDashboardOptions {
  /** Per-request nonce for the single `<style>` element (the page runs no script). */
  nonce: string;
  siteName: string;
  /** URL path of the dashboard: forms and links point at it. */
  path: string;
  /** Window choices (default 1, 7, 14, 30, 90 days). */
  windows?: number[];
}

const esc = (value: unknown): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const RATING_LABEL: Record<VitalRating, string> = {
  good: 'Good',
  'needs-improvement': 'Needs improvement',
  poor: 'Poor',
};
// Shape + word + colour: a rating never relies on colour alone.
const RATING_MARK: Record<VitalRating, string> = { good: '●', 'needs-improvement': '▲', poor: '■' };

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--ink:#14171c;--muted:#5b6472;--line:#dfe3e8;--accent:#2457d6;
--good:#17784a;--mid:#8f5a00;--poor:#c4262e;--good-bg:#e6f4ec;--mid-bg:#fbf0d9;--poor-bg:#fbe6e7;--grid:#c7cdd6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--panel:#171b21;--ink:#e8ebf0;--muted:#9aa4b2;--line:#2a313b;--accent:#7aa2ff;
--good:#43c07f;--mid:#e3b341;--poor:#ff7b72;--good-bg:#12291d;--mid-bg:#2d2410;--poor-bg:#33181a;--grid:#3a4350}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1120px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.05rem;margin:32px 0 12px}
.sub{color:var(--muted);margin:0 0 20px}
form.bar{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:0 0 20px}
label{display:flex;flex-direction:column;gap:4px;font-size:.82rem;color:var(--muted)}
select,input,button{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:7px 10px;min-height:38px}
button{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;cursor:pointer}
button:focus-visible,select:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input[type=search]{min-width:min(100%,280px)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card h3{margin:0;font-size:.95rem}.card .full{color:var(--muted);font-size:.78rem;margin:0 0 8px}
.value{font-size:1.9rem;font-weight:700;letter-spacing:-.02em;line-height:1.15}
.chip{display:inline-flex;gap:5px;align-items:center;font-size:.78rem;font-weight:600;border-radius:999px;padding:2px 9px;margin-top:4px}
.chip-good{color:var(--good);background:var(--good-bg)}.chip-needs-improvement{color:var(--mid);background:var(--mid-bg)}.chip-poor{color:var(--poor);background:var(--poor-bg)}
.meta{color:var(--muted);font-size:.78rem;margin:8px 0 0}
svg{display:block;max-width:100%}
.spark{margin-top:10px;width:100%;height:44px}
.ln{fill:none;stroke:var(--accent);stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round}
.dot{fill:var(--accent)}.th{stroke:var(--grid);stroke-width:1;stroke-dasharray:3 3}
.dist{width:100%;height:8px;margin-top:10px;border-radius:4px;overflow:hidden}
.seg-good{fill:var(--good)}.seg-needs-improvement{fill:var(--mid)}.seg-poor{fill:var(--poor)}
.scroll{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:640px}
th,td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{font-size:.78rem;color:var(--muted);font-weight:600}
tbody tr:last-child td{border-bottom:0}
td.route{max-width:340px;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}
.r-good{color:var(--good)}.r-needs-improvement{color:var(--mid)}.r-poor{color:var(--poor)}
.mark{font-size:.7rem;margin-right:5px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.notice{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:12px 16px;margin:0 0 16px}
.notice.error{border-left-color:var(--poor)}.notice.warn{border-left-color:var(--mid)}
.notice p{margin:0}.notice p+p{margin-top:6px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;background:var(--bg);padding:1px 5px;border-radius:4px}
footer{margin-top:32px;color:var(--muted);font-size:.8rem}footer a{color:var(--accent)}
`;

function sparkline(name: VitalName, trend: VitalsTrendPoint[], rating: VitalRating): string {
  const points = trend
    .map((p) => ({ t: p.t, v: p.metrics[name]?.p75 }))
    .filter((p): p is { t: number; v: number } => typeof p.v === 'number' && Number.isFinite(p.v));
  if (points.length < 2) return '';
  const [good, poor] = VITALS_THRESHOLDS[name];
  const max = Math.max(poor * 1.15, ...points.map((p) => p.v)) || 1;
  const w = 200;
  const h = 44;
  const x = (i: number) => 4 + (i / (points.length - 1)) * (w - 8);
  const y = (v: number) => h - 4 - (Math.min(v, max) / max) * (h - 8);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const label = `p75 ${name} trend, ${formatVital(name, first.v)} to ${formatVital(name, last.v)} (${RATING_LABEL[rating].toLowerCase()} now)`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
<line class="th" x1="0" x2="${w}" y1="${y(good).toFixed(1)}" y2="${y(good).toFixed(1)}"/>
<line class="th" x1="0" x2="${w}" y1="${y(poor).toFixed(1)}" y2="${y(poor).toFixed(1)}"/>
<polyline class="ln" points="${line}"/>
<circle class="dot" cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.6"/></svg>`;
}

function distributionBar(overall: VitalsOverall): string {
  const d = overall.distribution;
  const total = d.good + d['needs-improvement'] + d.poor;
  if (total <= 0) return '';
  const pct = (n: number) => (n / total) * 100;
  let offset = 0;
  const segments = (['good', 'needs-improvement', 'poor'] as const)
    .filter((r) => d[r] > 0)
    .map((r) => {
      const width = pct(d[r]);
      const rect = `<rect class="seg-${r}" x="${offset.toFixed(2)}" y="0" width="${width.toFixed(2)}" height="8"/>`;
      offset += width;
      return rect;
    })
    .join('');
  const summary = (['good', 'needs-improvement', 'poor'] as const)
    .map((r) => `${Math.round(pct(d[r]))}% ${RATING_LABEL[r].toLowerCase()}`)
    .join(', ');
  return `<svg class="dist" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${esc(`Share of measurements: ${summary}`)}">${segments}</svg>
<p class="meta">${esc(summary.replace(/, /g, ' · '))}</p>`;
}

function card(o: VitalsOverall, snapshot: VitalsSnapshot): string {
  const [good, poor] = VITALS_THRESHOLDS[o.name];
  return `<article class="card" aria-label="${esc(VITAL_LABELS[o.name])}">
<h3>${o.name}</h3><p class="full">${esc(VITAL_LABELS[o.name])}</p>
<div class="value">${esc(formatVital(o.name, o.p75))}</div>
<span class="chip chip-${o.rating}"><span aria-hidden="true">${RATING_MARK[o.rating]}</span>${RATING_LABEL[o.rating]}</span>
<p class="meta">p75 · median ${esc(formatVital(o.name, o.p50))} · ${esc(Math.round(o.samples).toLocaleString('en-US'))} measurement${Math.round(o.samples) === 1 ? '' : 's'}</p>
<p class="meta">good ≤ ${esc(formatVital(o.name, good))} · poor &gt; ${esc(formatVital(o.name, poor))}</p>
${distributionBar(o)}${sparkline(o.name, snapshot.trend, o.rating)}</article>`;
}

function routeTable(snapshot: VitalsSnapshot): string {
  if (snapshot.routes.length === 0) return '';
  const head = VITAL_NAMES.map((n) => `<th scope="col" title="${esc(VITAL_LABELS[n])}">${n}</th>`).join('');
  const rows = snapshot.routes
    .map((r) => {
      const cells = VITAL_NAMES.map((n) => {
        const m = r.metrics[n];
        if (!m) return '<td>—</td>';
        return `<td class="r-${m.rating}"><span class="mark" aria-hidden="true">${RATING_MARK[m.rating]}</span>${esc(formatVital(n, m.p75))}<span class="sr"> ${esc(RATING_LABEL[m.rating])}</span></td>`;
      }).join('');
      return `<tr><td class="route" title="${esc(r.route)}">${esc(r.route)}</td>${cells}<td>${esc(Math.round(r.samples).toLocaleString('en-US'))}</td></tr>`;
    })
    .join('\n');
  return `<h2>Routes</h2>
<div class="scroll" tabindex="0" role="region" aria-label="p75 per route"><table>
<caption class="sr">p75 per route and metric, most measured routes first</caption>
<thead><tr><th scope="col">Route</th>${head}<th scope="col">Measurements</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`;
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Server-rendered vitals dashboard: no script, one `<style>` element carrying the request nonce, inline SVG.
 * Every dynamic string is escaped. The caller sets the response headers (CSP, `no-store`, `noindex`).
 */
export function renderVitalsDashboard(view: VitalsDashboardView, options: VitalsDashboardOptions): string {
  const windows = options.windows ?? [1, 7, 14, 30, 90];
  if (!windows.includes(view.days)) windows.push(view.days);
  windows.sort((a, b) => a - b);
  const { snapshot } = view;
  const days = `${view.days} day${view.days === 1 ? '' : 's'}`;

  const notices: string[] = [];
  if (view.error)
    notices.push(
      `<div class="notice error" role="alert"><p><strong>Could not read Web Vitals.</strong></p><p>${esc(view.error)}</p></div>`,
    );
  if (snapshot?.source.partial)
    notices.push(
      '<div class="notice warn"><p><strong>Partial data.</strong> These numbers come from measurements held in memory by this server instance only. They reset on restart and do not include other instances.</p></div>',
    );
  if (view.notes?.length)
    notices.push(
      `<div class="notice">${view.notes
        .map(
          (n) =>
            `<p>${n
              .split(/(`[^`]+`)/)
              .map((s) =>
                s.startsWith('`') && s.endsWith('`') ? `<code>${esc(s.slice(1, -1))}</code>` : esc(s),
              )
              .join('')}</p>`,
        )
        .join('')}</div>`,
    );

  let body = '';
  if (snapshot) {
    if (snapshot.overall.length === 0) {
      body = `<div class="notice"><p>No Web Vitals were recorded in the last ${esc(days)}${view.route ? ` for <code>${esc(view.route)}</code>` : ''}. Measurements arrive when visitors load pages with the vitals reporter installed (<code>observe.vitals</code>).</p></div>`;
    } else {
      body = `<h2>${view.route ? `p75 for ${esc(view.route)}` : 'Site-wide p75'}</h2>
<section class="cards" aria-label="Core Web Vitals">${snapshot.overall.map((o) => card(o, snapshot)).join('\n')}</section>
${routeTable(snapshot)}`;
    }
  }

  const windowOptions = windows
    .map(
      (d) =>
        `<option value="${d}"${d === view.days ? ' selected' : ''}>${d} day${d === 1 ? '' : 's'}</option>`,
    )
    .join('');
  const jsonHref = `${options.path}?${new URLSearchParams({ days: String(view.days), ...(view.route ? { route: view.route } : {}), format: 'json' })}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Web Vitals · ${esc(options.siteName)}</title>
<style nonce="${esc(options.nonce)}">${STYLE}</style>
</head>
<body>
<main>
<h1>Web Vitals</h1>
<p class="sub">${esc(options.siteName)} · field data from real visitors, last ${esc(days)}</p>
<form class="bar" method="get" action="${esc(options.path)}">
<label>Window<select name="days">${windowOptions}</select></label>
<label>Route<input type="search" name="route" value="${esc(view.route ?? '')}" placeholder="all routes" maxlength="200" autocomplete="off"></label>
<button type="submit">Apply</button>
</form>
${notices.join('\n')}
${body}
<footer>
${snapshot ? `<p>Source: ${esc(snapshot.source.label)} · generated ${esc(utc(snapshot.generatedAt))} · trend buckets of ${esc(snapshot.bucketSeconds >= 86_400 ? `${snapshot.bucketSeconds / 86_400} day` : `${snapshot.bucketSeconds / 3600} h`)} · <a href="${esc(jsonHref)}">JSON</a></p>` : ''}
<p>p75 is the value 75% of visits are at or below; the thresholds are web.dev's. Dashed lines in the trends mark the good and poor limits.</p>
</footer>
</main>
</body>
</html>
`;
}
