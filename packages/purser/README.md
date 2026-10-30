# @hypdriv/purser

The HypDriv bridge for [Purser CSS](https://pursercss.dev) (`@avonao/purser`), the compile-time atomic CSS tool in which an overridden declaration cannot happen. Purser builds one deterministic stylesheet from your components; this package makes it first-class in a Next.js 16 application running on Cloudflare Workers (or anywhere HypDriv runs) without touching Purser itself: HypDriv consumes only `@avonao/purser/build` and `scripts/strike-count.js` ([ADR 0009](../../docs/adr/0009-purser-boundary.md)).

## What the bridge adds to Purser

| Capability | Where | Entry |
| --- | --- | --- |
| **In-process build and watch** — `withHypDriv` runs `build()` before `next build` and `watch()` once per `next dev` process; errors become build failures, dev diagnostics land in `.hypdriv/dev/purser.json` for the HUD | build / dev | `@hypdriv/purser/node` |
| **Unstyled-atom guard** — after `next build`, every Purser class referenced by prerendered HTML (and RSC payloads) must exist in the stylesheet; a stale stylesheet fails the build | adapter (`onBuildComplete`) | `@hypdriv/purser/node` |
| **Atom usage report** — atoms per route, unused atoms, stylesheet hash and size, written to `.hypdriv/manifest.json#purser` | adapter | `@hypdriv/purser/node` |
| **Flashless themes** — the `theme` stage reads a cookie or `Sec-CH-Prefers-*` client hints and pins the axis classes on `<html>` at the edge (HTMLRewriter, no inline script); a hashed inline fallback script covers non-Worker deployments and first visits | request time | `@hypdriv/purser` |
| **Layer coexistence** — one ordered `@layer` statement that places Purser's tokens and globals below your existing CSS and its atoms above it | adoption | `@hypdriv/purser` |
| **Zero-override audit** — headless Chrome crawl that evaluates Purser's `strike-count.js` at several widths, root themes, hover and keyboard focus; CI-ready | `hypdriv audit css` | `@hypdriv/purser/node` |

`@hypdriv/purser` has no runtime dependencies besides `@hypdriv/core`. `@avonao/purser` is an **optional host dependency**: nothing here imports it statically, and every tool degrades to a clear `HypDrivError('E_UNSUPPORTED')` with install instructions when it is missing.

## Install

```sh
pnpm add -D @avonao/purser typescript@^6
pnpm add @hypdriv/purser   # usually pulled in by @hypdriv/next
```

Purser parses your source with **your project's** `typescript` package and needs the programmatic compiler API, which exists in TypeScript 5.x and 6.x. **TypeScript 7** (the Go compiler) ships no programmatic API. On a TS 7 host, `detectPurser()` reports `typescriptCompatible: false` and the bridge refuses to start with the fix spelled out: keep `tsgo` / `@typescript/native-preview` for type checking and install TypeScript 6 under the `typescript` name,

```json
{ "devDependencies": { "typescript": "npm:@typescript/typescript6@^6" } }
```

or pin `typescript@^6`.

## Setup in `hypdriv.config.ts`

```ts
import { defineConfig } from 'hypdriv';

export default defineConfig({
  purser: {
    tokens: 'lib/tokens.ts', // auto-detected from lib/tokens.ts, lib/tokens.js, src/lib/tokens.ts, app/tokens.ts, tokens.ts
    src: ['app', 'components', 'lib'], // default
    out: 'app/purser.css', // default; import it once in app/layout.tsx
    prefix: 'x', // must match createCss({ prefix }) when you use a custom css instance
    verify: 'error', // unstyled-atom guard: 'error' | 'warn' | 'off'
    theme: {
      cookie: 'hyp_theme', // default
      axes: {
        mode: {
          classes: { light: null, dark: 'dark' },
          default: 'light',
          clientHint: { hint: 'prefers-color-scheme', values: { dark: 'dark', light: 'light' } },
        },
      },
    },
  },
});
```

Every `purser.*` option maps onto Purser's `BuildOptions` (`projectDir`, `src`, `tokens`, `out`, `prefix`, `salt`, `packageName`, `cssModule`, `layers`). `purser.project` (default `.`) is Purser's project root relative to the HypDriv project.

`withHypDriv` (from `@hypdriv/next`) then:

- in `PHASE_PRODUCTION_BUILD` awaits `bridge.build()` so Turbopack and webpack see a current `app/purser.css`, and fails the build when Purser reports errors (`bridge.formatDiagnostics(result)` prints them as `file:line:col: error: message`);
- in `PHASE_DEVELOPMENT_SERVER` starts `bridge.watch(undefined, { devDiagnostics: true })` once per process (later calls share the watcher) and publishes `.hypdriv/dev/purser.json` for the DevTools HUD and `/_hypdriv/dev/purser`;
- in the adapter's `onBuildComplete` runs `verifyBuild()` over the prerendered HTML and writes the result to the manifest.

The same operations are available from the command line: `hypdriv css build | check | watch` and `hypdriv audit css`.

### Using the bridge directly

```ts
import { createPurserBridge, verifyBuild, collectPrerenderedHtml } from '@hypdriv/purser/node';
import { loadConfigFile } from '@hypdriv/core/node';

const { resolved } = await loadConfigFile(projectDir);
const bridge = await createPurserBridge({ projectDir, config: resolved.purser!, log });
const result = await bridge.build(); // Purser's BuildResult: css, diagnostics, stats, written, outFile
if (bridge.hasErrors(result)) throw new Error(bridge.formatDiagnostics(result));

const verification = await verifyBuild({
  projectDir,
  config: resolved.purser!,
  prerenderedHtml: () => collectPrerenderedHtml(`${projectDir}/.next`, { includeRsc: true }),
});
if (!verification.ok) throw new Error(verification.errors.join('\n'));
manifest.purser = verification.manifest;
```

## The unstyled-atom guard

Purser class names are `prefix` + seven base-36 characters, computed identically at build time and at render time. If the stylesheet on disk is older than the components (a forgotten rebuild, a CI cache, a stale `out` file in git), the page references atoms that have no rule: an unstyled element with no error anywhere. The guard closes that gap after `next build`:

1. `collectPrerenderedHtml('.next')` reads `.next/server/app/**/*.html` and `.next/server/pages/**/*.html` (at most 2000 files of 2 MB each), keyed by pathname (`/index.html` → `/`, `/blog/[slug].html` stays the pattern). With `includeRsc: true` the `*.rsc` / `*.prefetch.rsc` payloads are appended to the same route so `className` strings in Flight output count too.
2. `extractAtomClasses(css, prefix)` lists the atoms the stylesheet declares: class selectors that are the subject of a rule, inside any nesting of `@layer`, `@media`, `@supports` and `@container`. Classes inside `:not(…)` are Purser's global exclusions (`body:not(.xce3dr7w) { color: … }`) and do not count; `@keyframes` names and declarations are ignored.
3. `extractHtmlClasses(html, prefix)` lists the classes a document references: `class` attributes and `"className":"…"` props in RSC payloads (also in their `\"`-escaped form inside `self.__next_f.push`).
4. `verifyAtoms({ html, css, prefix })` returns `{ missing, used, unused }`; `verifyBuild()` turns that into the manifest section and the pass/fail decision according to `purser.verify`.

`PurserManifest` (in `.hypdriv/manifest.json`):

```ts
{
  stylesheet: 'app/purser.css',      // project-relative source; the adapter may swap in the emitted asset URL (isPurserStylesheet() finds it)
  stylesheetHash: '3f9c…',           // first 16 hex chars of SHA-256, for ETags and cache keys
  atoms: 412, prefix: 'x',
  layers: { tokens: 'purser.tokens', globals: 'purser.globals', atoms: 'purser.atoms' },
  atomsByRoute: { '/': ['x27bzpr0', …] }, // when purser.usageReport (default true)
  unusedAtoms: ['xq3vd17w'],         // declared but referenced by no prerendered route (dead styles, or dynamic-only routes)
  missingAtoms: {},                  // route → classes without a rule; non-empty fails the build with verify: 'error'
  themeScript: '!function(){…}();', themeScriptHash: "'sha256-…'", // when a theme with fallbackScript is configured
}
```

`hypdriv routes --css` prints the per-route atoms and the unused list. A class that is not Purser's but happens to match `<prefix>[0-9a-z]{7}` (for example `xflexbox` with the default prefix) is reported as missing; choose a distinctive `purser.prefix` when legacy class names collide with the pattern.

## Flashless themes

Purser themes are root conditions: `axes: { mode: { light: ':not(.dark)', dark: '.dark' } }` in `defineTokens` makes every token switch with a class on `<html>`. The usual way to avoid a flash of the wrong theme is an inline script before hydration, which costs a CSP exception and still paints after the HTML arrived. HypDriv pins the classes **before the HTML leaves the edge** and keeps the script only as a fallback.

### Resolution

For every axis, in canonical (name-sorted) order:

1. the **theme cookie** (`hyp_theme` by default) when it holds a valid value;
2. the **client hint** header when `acceptClientHints` is on and the axis declares one: `Sec-CH-Prefers-Color-Scheme` (`dark`/`light`), `Sec-CH-Prefers-Contrast` (`more`/`less`/`custom`/`no-preference`), `Sec-CH-Prefers-Reduced-Motion` (`reduce`/`no-preference`), mapped through `clientHint.values` to an axis value;
3. the axis **default**.

Invalid values are skipped at each step. `resolveTheme(theme, { cookies, headers })` returns `{ values, classes, sources, header }`; `classes` is the list of non-null class names for `<html>`, and `header` is `axis=value;axis2=value2`.

The cookie holds all axes in one value: `hyp_theme=mode%3Ddark%3Bcontrast%3Dhigh` (URL-encoded `mode=dark;contrast=high`). A theme switcher writes it with `encodeThemeCookieValue(values, themeAxes(theme))`, or by hand:

```ts
document.cookie = `hyp_theme=${encodeURIComponent('mode=dark')}; Path=/; Max-Age=31536000; SameSite=Lax`;
```

A single-axis theme may also store the bare value (`hyp_theme=dark`).

### The `theme` stage

`themeStage(config)` runs at position 8 of the default pipeline, before `edge-cache` and `csp`:

- **pre** — resolves the axes, stores them under `THEME_KEY` (`axis → value`, also exposed as `hyp().theme`) and `THEME_RESOLVED_KEY` (the full resolution for DevTools), and forwards `x-hypdriv-theme: axis=value;…` to Next.js.
- **post** (HTML responses only) — on Cloudflare Workers, where `HTMLRewriter` exists, it rewrites the `<html>` start tag: selected classes are added, unselected theme classes removed (the pin is authoritative, other classes stay), and `data-hypdriv-theme="axis=value;…"` is set. Everywhere (Workers, `proxy.ts`, `next start`) it adds the negotiation headers: `Vary: Cookie`, and with `acceptClientHints` `Accept-CH: Sec-CH-Prefers-Color-Scheme, …` for the hints the axes use, `Critical-CH: Sec-CH-Prefers-Color-Scheme` (Chrome retries the very first navigation with the hint, so even a cookie-less first paint is right) and `Vary` on those hints. Without `HTMLRewriter` the stage is header-only and the fallback script applies the classes in the browser.
- The stage is skipped for RSC payload requests (`runOnRsc: false`): payloads carry no `<html>`. Server code that needs the theme during client navigations can call `resolveTheme()` on the request cookies.

The stage is portable: `@hypdriv/cloudflare` includes it in the Worker's default stages and `@hypdriv/next/proxy` in the proxy composables; the body transform simply activates when `globalThis.HTMLRewriter` is present. `themeElementHandler()` and `pinThemeResponse()` are exported for Worker shells that compose their own `HTMLRewriter` chain.

**Caching.** The pin runs after `edge-cache`'s post step, so cached bodies stay theme-neutral and every hit is pinned on the way out; no `vary` is needed for the classes alone. Only when server components themselves read the theme (`hyp().theme` / the `x-hypdriv-theme` header) must the matching edge-cache policy list the theme cookie under `vary.cookies` (and the hint under `vary.headers`), otherwise a dark-rendered body could be served to a light visitor. The response-level `Vary: Cookie` tells browser and shared caches the same thing.

### Fallback script and CSP

For deployments without `HTMLRewriter`, for first visits in browsers without client hints, and as belt-and-braces on Workers, render the inline script in the root layout `<head>`:

```tsx
// app/layout.tsx
import { resolveConfig } from '@hypdriv/core';
import { nonce } from '@hypdriv/next/server';
import { buildThemeScript } from '@hypdriv/purser';
import config from '../hypdriv.config';
import './purser.css';

const themeScript = buildThemeScript(resolveConfig(config).purser!.theme!);

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={await nonce()} data-hypdriv="theme" dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

Outside React (a Pages Router `_document`, a static HTML shell) `themeScriptTag(theme, nonce?)` returns the complete `<script>` element.

`buildThemeScript(theme)` is deterministic: axes, values and hint maps are sorted, the output contains no nonce or request data, so it is **byte-identical for equal configuration** and `themeScriptHash(theme)` (`'sha256-…'`) can be computed once. `verifyBuild()` writes both into the manifest (`purser.themeScript`, `purser.themeScriptHash`); the CSP stage adds the hash to `script-src` on hash-mode (static) routes, and nonce-mode routes get the nonce from `themeScriptTag(theme, nonce)`. The script reads the same cookie, falls back to `matchMedia('(prefers-color-scheme: dark)')` (and the other hints) for axes with a client hint, then to the defaults, and sets `data-hypdriv-theme`; every API access is guarded, so a sandboxed document without cookie access just gets the defaults.

Put `suppressHydrationWarning` on `<html>`: both the edge pin and the script change its `class` outside React, exactly as `next-themes` requires.

## Adopting Purser next to existing CSS

Purser's defaults, `purser.tokens`, `purser.globals` and `purser.atoms`, are sub-layers of one `purser` layer, so they sit together in the cascade. While Tailwind or legacy CSS still styles some elements, Purser's atoms must beat them and its globals must lose to them, which needs top-level names and one `@layer` statement at the very top of the first stylesheet the page loads (a `@layer` statement may precede `@import`):

```ts
import { layerStatement } from '@hypdriv/purser';

layerStatement({
  layers: { tokens: 'purser-tokens', globals: 'purser-globals', atoms: 'purser-atoms' },
  after: ['theme', 'base', 'components', 'utilities', 'legacy'],
});
// @layer purser-tokens, purser-globals, theme, base, components, utilities, legacy, purser-atoms;
```

`before` lists layers that sit beneath everything Purser emits, `after` the layers between globals and atoms. Pass the same names through `purser.layers` so the generated stylesheet uses them; `layerStatement` validates the names and refuses sub-layer names that cannot be ordered around `after` (`purser.atoms` cannot sit above `legacy` once `purser` was declared below it). Wrap unlayered legacy rules in a `legacy` layer: unlayered rules beat every layer, Purser's included.

## Zero-override audit

Purser proves by construction that no declaration in its stylesheet overrides another; third-party CSS on the same elements can still do so. `hypdriv audit css --url http://localhost:8787` crawls the routes in the manifest (or `purser.audit.routes`) and runs Purser's `scripts/strike-count.js`, the same check Purser's own browser test uses, at every configured width (`purser.audit.widths`, default 360/768/1280), root theme and state (`default`, `hover` over the first interactive element, keyboard `focus`). Any struck-through declaration fails the audit.

```ts
import { auditOverrides, formatAuditReport } from '@hypdriv/purser/node';

const report = await auditOverrides({
  urls: ['http://localhost:8787/', 'http://localhost:8787/blog/hello'],
  widths: [360, 768, 1280],
  states: ['default', 'hover', 'focus'],
  themeClasses: [[], ['dark'], ['dark', 'hc']], // root class sets; [] = as served
  timeoutMs: 30_000,
});
console.log(formatAuditReport(report));
process.exitCode = report.ok ? 0 : 1;
```

The audit launches headless Chrome itself (`--headless=new --remote-debugging-port=0 --user-data-dir=<tmp>`, `--no-sandbox` when running as root or in CI), speaks the DevTools protocol over Node 22's built-in `WebSocket` (one target per run, `Page.navigate` + `Page.loadEventFired` per URL/width/theme, `Emulation.setDeviceMetricsOverride`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` Tab for `:focus-visible`), and always kills Chrome and removes the profile, also on errors. Chrome is found through `chromePath` → `CHROME_PATH` / `PURSER_CHROME` → the usual macOS/Linux/Windows locations → `PATH`; when none exists the audit throws `HypDrivError('E_UNSUPPORTED')` with that list, so a CI job without Chrome fails loudly instead of silently passing. `strikeScript` can be passed explicitly (otherwise it is read from the project's `@avonao/purser`).

`AuditReport` is JSON-friendly: `{ ok, checks, durationMs, chrome: { path, version }, pages: [{ url, width, theme, state, count, struck: [{ element, pseudo, property, sources }], rules, skipped, error? }] }`.

## API

### `@hypdriv/purser` (runtime-neutral, no Node APIs)

| Export | Purpose |
| --- | --- |
| `THEME_KEY`, `THEME_RESOLVED_KEY` | `ctx.state` keys written by the stage |
| `resolveTheme(theme, { cookies, headers })`, `compileTheme`, `resolveCompiledTheme` | theme resolution |
| `themeStage(config)` | the `theme` stage |
| `buildThemeScript(theme)`, `themeScriptHash(theme)`, `themeScriptTag(theme, nonce?)` | fallback script |
| `themeAxes`, `allThemeClasses`, `themeClientHints`, `parseThemeCookie`, `encodeThemeValues`, `encodeThemeCookieValue`, `decodeThemeHeader`, `THEME_ATTRIBUTE`, `CLIENT_HINT_HEADERS`, `CLIENT_HINT_TOKENS` | theme building blocks |
| `applyThemeResponseHeaders`, `mergeThemeClasses`, `themeElementHandler`, `pinThemeResponse`, `getHtmlRewriter` | edge pin building blocks |
| `layerStatement({ layers, before?, after? })`, `LAYER_NAME_RE`, `DEFAULT_PURSER_LAYERS` | layer coexistence |
| `extractAtomClasses(css, prefix)`, `analyzeStylesheet`, `extractLayerStatement`, `isPurserStylesheet`, `atomClassPattern`, `stripCssComments` | stylesheet analysis |
| `extractHtmlClasses(html, prefix)` | document analysis |
| `verifyAtoms({ html, css, prefix })`, `verifyAtomsAgainst` | the guard |

### `@hypdriv/purser/node`

| Export | Purpose |
| --- | --- |
| `detectPurser(projectDir)` | `{ installed, version, packageDir, strikeScriptFile, typescriptVersion, typescriptCompatible, tokensFile, message }` |
| `createPurserBridge({ projectDir, config, log? })` | `PurserBridge`: `build()`, `check()`, `watch(onResult?, { devDiagnostics })`, `writeDevDiagnostics(result)`, `formatDiagnostics`, `formatSummary`, `stylesheetInfo(css)`, `readStylesheet()`, `hasErrors`, `options`, `outFile`, `tokensFile`, `detection` |
| `verifyBuild({ projectDir, config, prerenderedHtml, cssPath? })` | `{ ok, manifest, missingCount, errors, warnings, stylesheetFile, skipped }` |
| `collectPrerenderedHtml(distDir, { includeRsc?, maxFiles?, maxBytes? })` | prerendered documents by pathname |
| `auditOverrides(options)`, `formatAuditReport(report)` | the audit |
| `findChrome`, `launchChrome`, `createCdpClient`, `webSocketConnect` | the pieces the audit is built from (reusable, testable with an in-memory transport) |
| `purserBuildOptions`, `loadPurserBuildModule`, `closeAllPurserWatchers`, `readStrikeScript`, `TOKENS_FILE_CANDIDATES`, `TYPESCRIPT6_ALIAS_HINT` | helpers for the CLI and tests |

Purser's own types are mirrored as `PurserBuildOptions`, `PurserBuildResult`, `PurserDiagnostic`, `PurserBuildStats`, `PurserBuildModule`; the loaded module is validated at run time, so a future Purser without `build/check/watch` is reported as unsupported instead of crashing.

## Runtime matrix

| Feature | Cloudflare Workers | `proxy.ts` / `next start` | Build / CLI (Node 20.9+) |
| --- | --- | --- | --- |
| Theme resolution, `x-hypdriv-theme`, `Vary` / `Accept-CH` / `Critical-CH` | ✅ | ✅ | — |
| `<html>` pin without a script | ✅ (HTMLRewriter) | fallback script | — |
| Build, watch, guard, usage report | — | — | ✅ (needs `@avonao/purser` + TS ≤ 6 in the project) |
| Zero-override audit | — | — | ✅ (needs Chrome and Node 22+ for the global `WebSocket`) |

Part of [HypDriv](https://github.com/avonao/hypdriv). See `docs/architecture.md` §9 and `docs/contracts.md` for the integration contracts.
