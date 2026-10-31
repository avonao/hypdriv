'use client';

import type { TimingEntry } from '@hypdriv/core';
import type { CSSProperties, ReactNode } from 'react';
import type {
  DevState,
  DevToolsData,
  PurserStatus,
  RequestSummary,
  RscNavigation,
  VitalName,
  VitalSample,
} from './readers';
import { VITAL_THRESHOLDS } from './readers';
import { chipStyle, codeStyle, mutedStyle, type Theme } from './styles';

export interface PanelProps {
  theme: Theme;
  data: DevToolsData;
  endpoint: string;
  purserReachable: boolean | null;
  stateLoading: boolean;
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

function formatMs(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return value < 10 ? `${value.toFixed(2)} ms` : `${value.toFixed(1)} ms`;
}

export function toneForDesc(name: string, desc: string | undefined | null): Tone {
  if (!desc) return 'neutral';
  const d = desc.toUpperCase();
  if (name === 'cache') {
    if (d === 'HIT' || d === 'REVALIDATED') return 'good';
    if (d === 'MISS' || d === 'STALE' || d === 'ERROR-STALE') return 'warn';
    if (d === 'BYPASS' || d === 'DYNAMIC' || d === 'NEGATIVE') return 'info';
    return 'neutral';
  }
  if (name === 'csp') return d === 'OFF' ? 'warn' : 'info';
  if (name === 'bot') return d === 'HUMAN' || d === 'VERIFIED' ? 'good' : d === 'DEFINITE' ? 'bad' : 'warn';
  if (name === 'limit') return d.includes('LIMITED') || d.includes('BLOCK') ? 'bad' : 'info';
  if (d === 'ERROR') return 'bad';
  return 'neutral';
}

/** Stable React keys from content: repeated signatures get an occurrence suffix. */
function keyed<T>(items: readonly T[], signature: (item: T) => string): Array<{ key: string; item: T }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const sig = signature(item);
    const n = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, n);
    return { key: n === 1 ? sig : `${sig}#${n}`, item };
  });
}

const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', font: 'inherit' };

function cellStyle(theme: Theme, extra: CSSProperties = {}): CSSProperties {
  return {
    padding: '3px 4px',
    borderBottom: `1px solid ${theme.border}`,
    verticalAlign: 'middle',
    textAlign: 'left',
    ...extra,
  };
}

export function Empty({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <p style={{ ...mutedStyle(theme), margin: '8px 0' }}>{children}</p>;
}

export function Chip({
  theme,
  tone = 'neutral',
  children,
}: {
  theme: Theme;
  tone?: Tone;
  children: ReactNode;
}) {
  return <span style={chipStyle(theme, tone)}>{children}</span>;
}

export function TimingTable({
  theme,
  entries,
  label,
}: {
  theme: Theme;
  entries: TimingEntry[];
  label: string;
}) {
  const max = Math.max(1, ...entries.filter((e) => e.name !== 'total').map((e) => e.dur ?? 0));
  return (
    <table style={tableStyle} aria-label={label}>
      <thead>
        <tr>
          <th scope="col" style={cellStyle(theme, mutedStyle(theme))}>
            stage
          </th>
          <th scope="col" style={cellStyle(theme, { ...mutedStyle(theme), textAlign: 'right' })}>
            duration
          </th>
          <th scope="col" style={cellStyle(theme, mutedStyle(theme))}>
            detail
          </th>
        </tr>
      </thead>
      <tbody>
        {keyed(entries, (e) => `${e.name}|${e.dur ?? ''}|${e.desc ?? ''}`).map(({ key, item: entry }) => {
          const width =
            entry.dur === undefined ? 0 : Math.max(2, Math.round((Math.min(entry.dur, max) / max) * 100));
          return (
            <tr key={key}>
              <th scope="row" style={cellStyle(theme, { fontWeight: entry.name === 'total' ? 600 : 400 })}>
                {entry.name}
              </th>
              <td style={cellStyle(theme, { textAlign: 'right', whiteSpace: 'nowrap' })}>
                {formatMs(entry.dur)}
              </td>
              <td style={cellStyle(theme, { width: '45%' })}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  {entry.dur !== undefined && entry.name !== 'total' ? (
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-block',
                        height: 8,
                        width: `${width}%`,
                        background: theme.bar,
                        borderRadius: 2,
                      }}
                    />
                  ) : null}
                  {entry.desc ? (
                    <Chip theme={theme} tone={toneForDesc(entry.name, entry.desc)}>
                      {entry.desc}
                    </Chip>
                  ) : null}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function KeyValueTable({
  theme,
  rows,
  label,
}: {
  theme: Theme;
  rows: Array<[string, ReactNode]>;
  label: string;
}) {
  return (
    <table style={tableStyle} aria-label={label}>
      <tbody>
        {keyed(rows, ([k]) => k).map(({ key, item: [k, v] }) => (
          <tr key={key}>
            <th scope="row" style={cellStyle(theme, { ...mutedStyle(theme), width: 120, fontWeight: 400 })}>
              {k}
            </th>
            <td style={cellStyle(theme)}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RequestPanel({ theme, data }: PanelProps) {
  const r: RequestSummary = data.request;
  if (!r.entries.length) {
    return (
      <Empty theme={theme}>
        No Server-Timing entries on this navigation. Enable{' '}
        <code style={codeStyle(theme)}>observe.serverTiming</code> (verbose in development) and make sure the
        page was served through the Hypdriv Worker or proxy.
      </Empty>
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {r.cache ? (
          <Chip theme={theme} tone={toneForDesc('cache', r.cache)}>{`cache ${r.cache}`}</Chip>
        ) : null}
        {r.csp ? <Chip theme={theme} tone={toneForDesc('csp', r.csp)}>{`csp ${r.csp}`}</Chip> : null}
        {r.bot ? <Chip theme={theme} tone={toneForDesc('bot', r.bot)}>{`bot ${r.bot}`}</Chip> : null}
        {r.limit ? (
          <Chip theme={theme} tone={toneForDesc('limit', r.limit)}>{`limit ${r.limit}`}</Chip>
        ) : null}
        {r.flags ? <Chip theme={theme} tone="info">{`${r.flags} flags`}</Chip> : null}
        {r.total !== null ? <Chip theme={theme}>{`total ${formatMs(r.total)}`}</Chip> : null}
      </div>
      <TimingTable theme={theme} entries={r.entries} label="Server-Timing entries" />
    </div>
  );
}

const VITAL_ORDER: VitalName[] = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];

function formatVital(sample: VitalSample): string {
  return sample.name === 'CLS' ? sample.value.toFixed(3) : `${Math.round(sample.value)} ms`;
}

export function VitalsPanel({ theme, data }: PanelProps) {
  return (
    <div>
      <table style={tableStyle} aria-label="Web Vitals">
        <tbody>
          {VITAL_ORDER.map((name) => {
            const sample = data.vitals[name];
            const color = !sample
              ? theme.muted
              : sample.rating === 'good'
                ? theme.good
                : sample.rating === 'poor'
                  ? theme.bad
                  : theme.warn;
            const [good, poor] = VITAL_THRESHOLDS[name];
            const unit = name === 'CLS' ? '' : ' ms';
            return (
              <tr key={name}>
                <th scope="row" style={cellStyle(theme, { fontWeight: 600, width: 60 })}>
                  {name}
                </th>
                <td style={cellStyle(theme, { textAlign: 'right', color, whiteSpace: 'nowrap', width: 80 })}>
                  {sample ? formatVital(sample) : '—'}
                </td>
                <td style={cellStyle(theme)}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 999,
                        background: color,
                        display: 'inline-block',
                      }}
                    />
                    <span style={mutedStyle(theme)}>
                      {`${sample ? sample.rating : 'waiting'}${sample?.provisional ? ' (provisional)' : ''} · good ≤ ${good}${unit}, poor > ${poor}${unit}`}
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ ...mutedStyle(theme), marginTop: 8 }}>
        LCP settles after the first interaction; CLS and INP accumulate for the page's lifetime. INP is
        approximated from the longest Event Timing interaction.
      </p>
    </div>
  );
}

export function NavigationPanel({ theme, data }: PanelProps) {
  const navs: RscNavigation[] = data.navigations;
  if (!navs.length) {
    return (
      <Empty theme={theme}>
        No RSC payload fetches yet. Navigate client-side (links, router.push) to see their Server-Timing.
      </Empty>
    );
  }
  const newestFirst = keyed(navs.slice().reverse(), (n) => `${n.url}@${n.startTime}`);
  return (
    <div>
      {newestFirst.map(({ key, item: nav }) => (
        <details key={key} style={{ borderBottom: `1px solid ${theme.border}`, padding: '4px 0' }}>
          <summary style={{ cursor: 'pointer' }}>
            <code style={codeStyle(theme)}>{nav.url}</code> <span>{formatMs(nav.duration)}</span>{' '}
            {nav.cache ? (
              <Chip theme={theme} tone={toneForDesc('cache', nav.cache)}>
                {nav.cache}
              </Chip>
            ) : null}
          </summary>
          {nav.entries.length ? (
            <div style={{ paddingTop: 4 }}>
              <TimingTable theme={theme} entries={nav.entries} label={`Server-Timing for ${nav.url}`} />
            </div>
          ) : (
            <Empty theme={theme}>No Server-Timing on this fetch.</Empty>
          )}
        </details>
      ))}
    </div>
  );
}

export function FlagsPanel({ theme, data }: PanelProps) {
  if (!data.flags) {
    return (
      <Empty theme={theme}>
        No <code style={codeStyle(theme)}>{'<meta name="hypdriv:flags">'}</code> tag. Render the Hypdriv meta
        tags from the server helpers (<code style={codeStyle(theme)}>@hypdriv/next</code>) to see the flags
        evaluated for this request.
      </Empty>
    );
  }
  const names = Object.keys(data.flags);
  if (!names.length) return <Empty theme={theme}>No flags defined.</Empty>;
  const rows: Array<[string, ReactNode]> = names.map((name) => {
    const value = data.flags?.[name];
    const tone: Tone = typeof value === 'boolean' ? (value ? 'good' : 'neutral') : 'info';
    return [
      name,
      <Chip key={name} theme={theme} tone={tone}>
        {String(value)}
      </Chip>,
    ];
  });
  return <KeyValueTable theme={theme} rows={rows} label="Feature flags" />;
}

export function PurserPanel({ theme, data, endpoint, purserReachable }: PanelProps) {
  const status: PurserStatus | null = data.purser;
  if (purserReachable === false || !status) {
    return (
      <Empty theme={theme}>
        Purser bridge not running ({endpoint}/purser unreachable). Start{' '}
        <code style={codeStyle(theme)}>next dev</code> with <code style={codeStyle(theme)}>withHypDriv</code>{' '}
        and Purser enabled to see live diagnostics.
      </Empty>
    );
  }
  const errors = status.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = status.diagnostics.filter((d) => d.severity === 'warning').length;
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <Chip theme={theme} tone={status.ok ? 'good' : 'bad'}>
          {status.ok ? 'stylesheet ok' : 'build failed'}
        </Chip>
        {status.atoms !== null ? <Chip theme={theme}>{`${status.atoms} atoms`}</Chip> : null}
        {status.durationMs !== null ? <Chip theme={theme}>{formatMs(status.durationMs)}</Chip> : null}
        {status.builtAt ? <Chip theme={theme}>{`built ${status.builtAt}`}</Chip> : null}
        {errors ? <Chip theme={theme} tone="bad">{`${errors} errors`}</Chip> : null}
        {warnings ? <Chip theme={theme} tone="warn">{`${warnings} warnings`}</Chip> : null}
      </div>
      {status.diagnostics.length ? (
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {keyed(status.diagnostics, (d) => `${d.severity}|${d.file ?? ''}|${d.line ?? ''}|${d.message}`).map(
            ({ key, item: d }) => {
              const location = d.file
                ? `${d.file}${d.line !== undefined ? `:${d.line}${d.column !== undefined ? `:${d.column}` : ''}` : ''}`
                : null;
              return (
                <li key={key} style={{ marginBottom: 4 }}>
                  <Chip
                    theme={theme}
                    tone={d.severity === 'error' ? 'bad' : d.severity === 'warning' ? 'warn' : 'info'}
                  >
                    {d.severity}
                  </Chip>{' '}
                  {location ? <code style={codeStyle(theme)}>{location}</code> : null} {d.message}
                  {d.code ? <span style={mutedStyle(theme)}>{` (${d.code})`}</span> : null}
                </li>
              );
            },
          )}
        </ul>
      ) : (
        <Empty theme={theme}>No diagnostics. Every referenced atom exists in the stylesheet.</Empty>
      )}
    </div>
  );
}

export function BuildPanel({ theme, data }: PanelProps) {
  const b = data.build;
  const candidates: Array<[string, string | null]> = [
    ['build', b.build],
    ['route', b.route],
    ['runner', b.runner],
    ['deployment', b.deployment],
    ['request id', b.requestId],
    ['locale', b.locale],
    ['cache', b.cache],
    ['csp', b.csp],
    ['next', b.nextVersion],
    ['hypdriv', b.hypdrivVersion],
    ...Object.entries(b.extra),
  ];
  const rows: Array<[string, ReactNode]> = candidates
    .filter((row): row is [string, string] => typeof row[1] === 'string' && row[1] !== '')
    .map(([k, v]) => [
      k,
      <code key={k} style={codeStyle(theme)}>
        {v}
      </code>,
    ]);
  if (!rows.length) {
    return (
      <Empty theme={theme}>
        No <code style={codeStyle(theme)}>{'<meta name="hypdriv:*">'}</code> tags found. Render them from the
        server helpers to see build id, route and runner here.
      </Empty>
    );
  }
  return <KeyValueTable theme={theme} rows={rows} label="Build information" />;
}

export function CapabilitiesPanel({ theme, data, endpoint, stateLoading }: PanelProps) {
  const state: DevState | null = data.state;
  if (stateLoading) return <Empty theme={theme}>{`Loading ${endpoint}/state …`}</Empty>;
  if (!state) {
    return (
      <Empty theme={theme}>
        {`${endpoint}/state is not available. The Worker shell and proxy serve it in development; in production it is off.`}
      </Empty>
    );
  }
  const caps = state.capabilities ?? {};
  const rows: Array<[string, ReactNode]> = Object.entries(caps).map(([name, value]) => {
    const on = Array.isArray(value) ? value.length > 0 : Boolean(value);
    const label = Array.isArray(value) ? (value.length ? value.join(', ') : 'none') : on ? 'yes' : 'no';
    return [
      name,
      <Chip key={name} theme={theme} tone={on ? 'good' : 'neutral'}>
        {label}
      </Chip>,
    ];
  });
  const footer = [
    state.runner && `runner ${state.runner}`,
    state.development === null ? null : state.development ? 'development' : 'production',
    state.buildId && `build ${state.buildId}`,
    state.hypdrivVersion && `hypdriv ${state.hypdrivVersion}`,
    state.nextVersion && `next ${state.nextVersion}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div>
      {state.summary.length ? (
        <ul style={{ margin: '0 0 8px', paddingLeft: 16 }}>
          {state.summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {rows.length ? (
        <KeyValueTable theme={theme} rows={rows} label="Capabilities" />
      ) : (
        <Empty theme={theme}>No capability report in the state payload.</Empty>
      )}
      {state.config || Object.keys(state.details).length ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer' }}>details</summary>
          <pre style={{ ...codeStyle(theme), whiteSpace: 'pre-wrap', margin: '6px 0 0', padding: 8 }}>
            {JSON.stringify({ ...(state.config ? { config: state.config } : {}), ...state.details }, null, 2)}
          </pre>
        </details>
      ) : null}
      {footer ? <p style={mutedStyle(theme)}>{footer}</p> : null}
    </div>
  );
}
