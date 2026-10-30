'use client';

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formatHotkey, matchesHotkey, parseHotkey } from './hotkey';
import {
  BuildPanel,
  CapabilitiesPanel,
  FlagsPanel,
  NavigationPanel,
  PurserPanel,
  RequestPanel,
  VitalsPanel,
} from './panels';
import {
  collectDevToolsData,
  type DevState,
  type DevToolsData,
  type PurserStatus,
  type RscNavigation,
  readDevState,
  readPurserDiagnostics,
  readRequestFacts,
  type VitalSample,
} from './readers';
import {
  bodyStyle,
  chipStyle,
  DARK,
  headerStyle,
  iconButtonStyle,
  LIGHT,
  mutedStyle,
  type Position,
  panelStyle,
  pillStyle,
  srOnly,
  type Theme,
  tabListStyle,
  tabStyle,
} from './styles';
import { observeRscNavigations, observeVitals } from './vitals';

export type { Hotkey, KeyboardEventLike } from './hotkey';
export { formatHotkey, matchesHotkey, parseHotkey } from './hotkey';
export type {
  BuildInfo,
  DevState,
  DevToolsData,
  DocumentLike,
  PurserDiagnostic,
  PurserStatus,
  RequestSummary,
  RscNavigation,
  ServerTimingLike,
  VitalName,
  VitalRating,
  VitalSample,
} from './readers';
export {
  collectDevToolsData,
  decodeFlags,
  mergeBuildInfo,
  normalizeDevState,
  normalizePurser,
  parseServerTimingHeader,
  rateVital,
  readAllMeta,
  readBuildMeta,
  readDevState,
  readFlagsMeta,
  readMeta,
  readPurserDiagnostics,
  readRequestFacts,
  readRscNavigations,
  readServerTimingEntries,
  readTtfb,
  rscNavigationFromEntry,
  serverTimingFromEntries,
  summarizeRequest,
  VITAL_THRESHOLDS,
} from './readers';
export type { Position } from './styles';
export { observeRscNavigations, observeVitals } from './vitals';

export interface HypDrivDevToolsProps {
  /** Corner of the viewport (default `bottom-right`). */
  position?: Position;
  /** Toggle shortcut (default `Alt+Shift+H`; `false` disables it). */
  hotkey?: string | false;
  /** Dev endpoint base (default `/_hypdriv/dev`): `<endpoint>/purser` is polled, `<endpoint>/state` fetched once. */
  endpoint?: string;
  /** Open on first render (the remembered state from a previous visit wins afterwards). */
  initialOpen?: boolean;
  /** Purser polling interval while the panel is open (default 3000 ms). */
  pollIntervalMs?: number;
}

type TabId = 'request' | 'vitals' | 'navigation' | 'flags' | 'purser' | 'build' | 'capabilities';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'request', label: 'Request' },
  { id: 'vitals', label: 'Vitals' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'flags', label: 'Flags' },
  { id: 'purser', label: 'Purser' },
  { id: 'build', label: 'Build' },
  { id: 'capabilities', label: 'Capabilities' },
];

const STORAGE_OPEN = 'hypdriv:devtools:open';
const STORAGE_TAB = 'hypdriv:devtools:tab';
const EMPTY_DATA: DevToolsData = {
  request: { entries: [], total: null, cache: null, csp: null, bot: null, limit: null, flags: null },
  vitals: {},
  navigations: [],
  flags: null,
  build: {
    build: null,
    route: null,
    runner: null,
    deployment: null,
    requestId: null,
    locale: null,
    cache: null,
    csp: null,
    nextVersion: null,
    hypdrivVersion: null,
    extra: {},
  },
  purser: null,
  state: null,
};

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // private mode / blocked storage
  }
}

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    if (!mq) return;
    setDark(mq.matches);
    const onChange = (e: { matches: boolean }) => setDark(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return dark;
}

/**
 * The HypDriv HUD: a floating pill that opens a panel with Request (Server-Timing per stage), Vitals,
 * Navigation (RSC fetch timings), Flags, Purser, Build and Capabilities tabs. Pure React 19, inline
 * styles, no endpoints required for the first four tabs (ADR 0008); `<endpoint>/purser` and
 * `<endpoint>/state` are optional dev routes. Render it only in development/preview — `@hypdriv/next`
 * wraps it in a lazy, environment-gated component.
 */
export function HypDrivDevTools({
  position = 'bottom-right',
  hotkey = 'Alt+Shift+H',
  endpoint = '/_hypdriv/dev',
  initialOpen = false,
  pollIntervalMs = 3000,
}: HypDrivDevToolsProps = {}) {
  const [open, setOpen] = useState(initialOpen);
  const [tab, setTab] = useState<TabId>('request');
  const [data, setData] = useState<DevToolsData>(EMPTY_DATA);
  const [purserReachable, setPurserReachable] = useState<boolean | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const stateFetched = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dark = usePrefersDark();
  const theme: Theme = dark ? DARK : LIGHT;
  const parsedHotkey = useMemo(() => (hotkey === false ? null : parseHotkey(hotkey)), [hotkey]);

  // Remembered state (effect: reading storage during render would break hydration).
  useEffect(() => {
    const remembered = readStorage(STORAGE_OPEN);
    if (remembered === '1') setOpen(true);
    else if (remembered === '0' && !initialOpen) setOpen(false);
    const rememberedTab = readStorage(STORAGE_TAB) as TabId | null;
    if (rememberedTab && TABS.some((t) => t.id === rememberedTab)) setTab(rememberedTab);
  }, [initialOpen]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      writeStorage(STORAGE_OPEN, prev ? '0' : '1');
      return !prev;
    });
  }, []);

  const selectTab = useCallback((next: TabId) => {
    setTab(next);
    writeStorage(STORAGE_TAB, next);
  }, []);

  // Navigation timing, meta tags, vitals and RSC fetches.
  useEffect(() => {
    setData((prev) => ({ ...prev, ...collectDevToolsData(), purser: prev.purser, state: prev.state }));
    const stopVitals = observeVitals((sample: VitalSample) => {
      setData((prev) => ({ ...prev, vitals: { ...prev.vitals, [sample.name]: sample } }));
    });
    const seen = new Set<string>();
    const stopRsc = observeRscNavigations((nav: RscNavigation) => {
      const key = `${nav.url}@${nav.startTime}`;
      if (seen.has(key)) return;
      seen.add(key);
      setData((prev) => ({ ...prev, navigations: [...prev.navigations.slice(-49), nav] }));
    });
    return () => {
      stopVitals();
      stopRsc();
    };
  }, []);

  // Hotkey.
  useEffect(() => {
    if (!parsedHotkey || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (matchesHotkey(event, parsedHotkey)) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parsedHotkey, toggle]);

  // Purser polling while open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const tick = async () => {
      const status: PurserStatus | null = await readPurserDiagnostics(endpoint);
      if (cancelled) return;
      if (status) {
        failures = 0;
        setPurserReachable(true);
        setData((prev) => ({ ...prev, purser: status }));
      } else {
        failures++;
        setPurserReachable(false);
      }
      timer = setTimeout(tick, failures > 1 ? Math.min(pollIntervalMs * 5, 30_000) : pollIntervalMs);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, endpoint, pollIntervalMs]);

  // Capabilities state, fetched once per mount when the panel first opens.
  useEffect(() => {
    if (!open || stateFetched.current) return;
    stateFetched.current = true;
    let cancelled = false;
    setStateLoading(true);
    void readDevState(endpoint).then((state: DevState | null) => {
      if (cancelled) return;
      setStateLoading(false);
      setData((prev) => ({ ...prev, state }));
    });
    return () => {
      cancelled = true;
    };
  }, [open, endpoint]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      toggle();
    }
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  const hotkeyLabel = formatHotkey(parsedHotkey);
  const summary = data.request;
  const lcp = data.vitals.LCP;
  const lcpColor = !lcp
    ? theme.muted
    : lcp.rating === 'good'
      ? theme.good
      : lcp.rating === 'poor'
        ? theme.bad
        : theme.warn;
  const errors = data.purser?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;

  const panelProps = { theme, data, endpoint, purserReachable, stateLoading };
  const panel =
    tab === 'request' ? (
      <RequestPanel {...panelProps} />
    ) : tab === 'vitals' ? (
      <VitalsPanel {...panelProps} />
    ) : tab === 'navigation' ? (
      <NavigationPanel {...panelProps} />
    ) : tab === 'flags' ? (
      <FlagsPanel {...panelProps} />
    ) : tab === 'purser' ? (
      <PurserPanel {...panelProps} />
    ) : tab === 'build' ? (
      <BuildPanel {...panelProps} />
    ) : (
      <CapabilitiesPanel {...panelProps} />
    );

  if (!open) {
    return (
      <button
        type="button"
        data-hypdriv-devtools="pill"
        aria-label={`Open HypDriv DevTools${hotkeyLabel ? ` (${hotkeyLabel})` : ''}`}
        aria-expanded={false}
        title={hotkeyLabel ? `HypDriv DevTools · ${hotkeyLabel}` : 'HypDriv DevTools'}
        onClick={toggle}
        style={pillStyle(theme, position)}
      >
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: 999, background: lcpColor, display: 'inline-block' }}
        />
        <strong style={{ fontWeight: 600 }}>HypDriv</strong>
        {summary.total !== null ? (
          <span style={mutedStyle(theme)}>
            {summary.total < 10 ? summary.total.toFixed(1) : Math.round(summary.total)} ms
          </span>
        ) : null}
        {summary.cache ? (
          <span
            style={chipStyle(
              theme,
              summary.cache === 'HIT' ? 'good' : summary.cache === 'MISS' ? 'warn' : 'info',
            )}
          >
            {summary.cache}
          </span>
        ) : null}
        {errors ? <span style={chipStyle(theme, 'bad')}>{errors} css</span> : null}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      data-hypdriv-devtools="panel"
      role="dialog"
      aria-label="HypDriv DevTools"
      aria-modal={false}
      onKeyDown={onPanelKeyDown}
      style={panelStyle(theme, position)}
    >
      <div style={headerStyle(theme)}>
        <strong style={{ fontWeight: 600 }}>HypDriv DevTools</strong>
        {data.build.build ? <span style={chipStyle(theme)}>build {data.build.build}</span> : null}
        {data.build.runner ? <span style={chipStyle(theme, 'info')}>{data.build.runner}</span> : null}
        <span style={{ flex: 1 }} />
        {hotkeyLabel ? <span style={mutedStyle(theme)}>{hotkeyLabel}</span> : null}
        <button
          type="button"
          aria-label="Close HypDriv DevTools"
          onClick={toggle}
          style={iconButtonStyle(theme)}
        >
          ×
        </button>
      </div>
      <div role="tablist" aria-label="DevTools sections" style={tabListStyle(theme)}>
        {TABS.map((t, index) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`hypdriv-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`hypdriv-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => selectTab(t.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            style={tabStyle(theme, tab === t.id)}
          >
            {t.label}
            {t.id === 'purser' && errors ? (
              <span style={{ ...chipStyle(theme, 'bad'), marginLeft: 4 }}>{errors}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`hypdriv-panel-${tab}`}
        aria-labelledby={`hypdriv-tab-${tab}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable tabpanel must be keyboard-focusable (WAI-ARIA APG tabs pattern)
        tabIndex={0}
        style={bodyStyle()}
      >
        <span style={srOnly}>{TABS.find((t) => t.id === tab)?.label}</span>
        {panel}
      </div>
    </div>
  );
}

export default HypDrivDevTools;
