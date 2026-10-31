# @hypdriv/devtools

The [Hypdriv](https://github.com/avonao/hypdriv) in-app HUD: a floating pill that opens a panel with per-stage **Server-Timing**, **Web Vitals**, **RSC navigation** timings, **feature flags**, **Purser** diagnostics, **build** info and runtime **capabilities**. Pure React 19, inline styles only, zero dependencies besides `@hypdriv/core`, no Next.js import.

Per ADR 0008 the HUD needs no endpoint for its core data: every Hypdriv stage emits a `Server-Timing` entry and the browser exposes those through `PerformanceNavigationTiming.serverTiming` / `PerformanceResourceTiming.serverTiming`.

## Install

```sh
pnpm add @hypdriv/devtools
```

Most applications render it through `@hypdriv/next`'s `<HypDrivDevTools/>`, which lazy-loads this package and only mounts it in development/preview (`devtools.enabled`). To mount it directly:

```tsx
'use client';
import { HypDrivDevTools } from '@hypdriv/devtools';

export function DevTools() {
  if (process.env.NODE_ENV === 'production') return null;
  return <HypDrivDevTools position="bottom-right" hotkey="Alt+Shift+H" endpoint="/_hypdriv/dev" />;
}
```

Props: `position` (`bottom-right` default, or `bottom-left` / `top-left` / `top-right`), `hotkey` (`Alt+Shift+H`; `false` disables; `Mod+K`-style strings accepted), `endpoint` (`/_hypdriv/dev`), `initialOpen`, `pollIntervalMs` (Purser polling, 3 s). Open/closed state and the active tab are remembered in `localStorage` (guarded; private mode is fine). `prefers-color-scheme` picks the palette. The panel is a `role="dialog"` with a roving-tabindex tab list (arrow keys, Home/End), Escape closes it, and it sits at `z-index: 2147483000`.

## Tabs

| Tab | Source | Notes |
| --- | --- | --- |
| Request | `performance.getEntriesByType('navigation')[0].serverTiming` | one row per stage with a duration bar; `cache` HIT/MISS/STALE, `csp` mode, `bot` verdict and `limit` are highlighted as chips |
| Vitals | `PerformanceObserver` (`largest-contentful-paint`, `layout-shift`, `event`, `paint`) + navigation `responseStart` | LCP, INP (approximated from the longest Event Timing interaction), CLS, FCP, TTFB with web.dev ratings |
| Navigation | `resource` entries for `fetch` requests containing `?_rsc=` | RSC payload fetches of client-side navigations with their Server-Timing |
| Flags | `<meta name="hypdriv:flags" content="<base64url JSON>">` | the same encoding as the `x-hypdriv-flags` header (`encodeFlagsHeader` in `@hypdriv/flags`) |
| Purser | `GET <endpoint>/purser` polled every 3 s while open | diagnostics with severity and `file:line:column`; "bridge not running" when unreachable (polling slows to 15 s) |
| Build | `<meta name="hypdriv:build|route|runner|deployment|request-id|cache|csp|next|version">` plus any other `hypdriv:*` tag | rendered by the `hyp()` server helpers in `@hypdriv/next` |
| Capabilities | `GET <endpoint>/state` once when first opened | `{ capabilities, summary?: string[], config?, runner?, buildId?, hypdrivVersion?, nextVersion? }` |

### Expected payloads

`<endpoint>/purser` (`.hypdriv/dev/purser.json` as written by the Purser bridge) is accepted in several shapes; the canonical one is:

```json
{ "ok": false, "atoms": 1200, "builtAt": "2026-10-30T12:00:00Z", "durationMs": 180,
  "diagnostics": [{ "severity": "error", "message": "Unknown atom x-foo", "file": "app/page.tsx", "line": 12, "column": 3, "code": "E_ATOM" }] }
```

`{ errors: [...], warnings: [...] }` and `{ result: {...} }` wrappers are normalised too. `<endpoint>/state` is the JSON served by the Worker shell / proxy dev routes; `capabilities` is core's `Capabilities` object and `summary` the lines from `describeCapabilities()`.

## Helpers

Everything the HUD reads is exported for custom tooling and tests:

- `readServerTimingEntries()`, `serverTimingFromEntries(entries)`, `parseServerTimingHeader(header)`, `summarizeRequest(entries)`, `readTtfb()`
- `readMeta(name)`, `readAllMeta()`, `readFlagsMeta()`, `decodeFlags(value)`, `readBuildMeta()`
- `readRscNavigations()`, `rscNavigationFromEntry(entry)`, `observeRscNavigations(listener)`
- `observeVitals(listener)`, `rateVital(name, value)`, `VITAL_THRESHOLDS`
- `readPurserDiagnostics(endpoint)`, `normalizePurser(raw)`, `readDevState(endpoint)`, `normalizeDevState(raw)`
- `collectDevToolsData()` → one `DevToolsData` snapshot (handy for bug reports)
- `parseHotkey(string)`, `matchesHotkey(event, hotkey)`, `formatHotkey(hotkey)`

All readers accept an injected `document`/`fetch` so they run in Node tests, and return empty values outside a browser; the component renders safely with `renderToString`.

## License

MIT
