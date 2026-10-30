# Purser CSS with HypDriv

[Purser CSS](https://pursercss.dev) compiles styles written next to your components into one deterministic atomic stylesheet in which no declaration is ever overridden. HypDriv makes Purser first-class in a Next.js 16 project without touching Purser itself (ADR 0009).

## Setup

```sh
pnpm add @avonao/purser
```

```ts
// hypdriv.config.ts
purser: {
  tokens: 'lib/tokens.ts',
  src: ['app', 'components', 'lib'],
  out: 'app/purser.css',
  theme: {
    axes: {
      mode: {
        classes: { light: null, dark: 'dark' },
        default: 'light',
        clientHint: { hint: 'prefers-color-scheme', values: { dark: 'dark', light: 'light' } },
      },
      contrast: { classes: { normal: null, high: 'hc' }, default: 'normal', clientHint: { hint: 'prefers-contrast', values: { more: 'high' } } },
    },
  },
}
```

Import the stylesheet once in `app/layout.tsx` (`import './purser.css'`). That is all: `withHypDriv` runs Purser for you.

## What the bridge does

1. **Build and watch in-process.** `next build` awaits `purser build` before Turbopack starts, so the bundler always sees a current stylesheet; errors fail the build with Purser's `file:line:col` diagnostics. `next dev` starts `purser build --watch` once and shows diagnostics in the HUD's Purser panel. No `&` process juggling, no stale CSS.
2. **Unstyled-atom guard.** After the build, every Purser class referenced by prerendered HTML (and RSC payloads) must exist in the stylesheet. A missing atom means the stylesheet is stale or a component bypassed the build; the build fails (`purser.verify: 'error'`, or `'warn'`).
3. **Atom usage report.** `hypdriv routes --css` lists atoms per route and atoms no prerendered route references (dead styles). The manifest stores `purser.atomsByRoute` and `purser.unusedAtoms`.
4. **Flashless themes.** The `theme` stage resolves each axis from the `hyp_theme` cookie (`mode=dark;contrast=high`) or the `Sec-CH-Prefers-Color-Scheme` / `Sec-CH-Prefers-Contrast` client hints, and pins the classes on `<html>` with `HTMLRewriter` before the HTML leaves the edge — no inline script, no flash, CSP-clean. `Accept-CH`, `Critical-CH` and `Vary` headers are emitted. For non-Worker deployments a deterministic fallback script is available (`buildThemeScript`), and its hash is part of the static CSP automatically.
5. **Early Hints** include the stylesheet chunk that contains Purser's output on every route.
6. **Zero-override audit.** `hypdriv audit css --url http://localhost:8787` crawls the routes in the manifest with headless Chrome, at 360/768/1280 px and in default/hover/focus states, running Purser's `strike-count.js`. Any struck-through declaration fails the audit. Use it in CI after `pnpm preview`.
7. **Layer coexistence.** `layerStatement({ layers, before: ['tailwind'], after: ['legacy'] })` prints the `@layer` order to adopt Purser next to existing CSS as described in Purser's docs.

## Switching themes

```tsx
'use client';
export function ThemeToggle() {
  return (
    <button onClick={() => { document.cookie = 'hyp_theme=mode%3Ddark; Path=/; Max-Age=31536000; SameSite=Lax'; location.reload(); }}>
      Dark
    </button>
  );
}
```

Or call `setTheme({ mode: 'dark' })` from `@hypdriv/purser` which writes the cookie and toggles the class without a reload. Edge cache policies for themed routes should `vary.cookies: ['hyp_theme']` (inferred policies do this automatically when a theme is configured).

## TypeScript 7

Purser uses TypeScript's programmatic API to extract styles. TypeScript 7.0 ships without a stable programmatic API, so Purser needs TypeScript 6 at build time. `hypdriv doctor` detects a TS 7 host and recommends `pnpm add -D typescript@^6` or the `@typescript/typescript6` alias for the build step; your editor can keep using 7.
