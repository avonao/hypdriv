# Purser CSS with Hypdriv

[Purser CSS](https://pursercss.dev) compiles styles written next to your components into one deterministic atomic stylesheet in which no declaration is ever overridden. Hypdriv makes Purser first-class in a Next.js 16 project without touching Purser itself (ADR 0009).

Purser is one of Hypdriv's sister products, together with SquawkCode (which proves that a CSS change did not change the look). How the three fit together is described in [Ecosystem](../ecosystem.md).

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

## Compiled modules, minimal names and fused classes (Purser 0.2)

From `@avonao/purser` 0.2 the build can do more than write the stylesheet: it can compile your modules, so the browser runs no style code at all, give classes the shortest names there are, and give classes that are always applied together one class. Hypdriv sets up all of it from the configuration:

```ts
// hypdriv.config.ts
purser: {
  tokens: 'lib/tokens.ts',
  src: ['app', 'components', 'lib'],
  out: 'app/purser.css',
  names: 'min',          // _a, _b, …: the most used class gets the shortest name
  granularity: 'rule',   // one class per rule instead of one per property
  minify: true,
  fuse: 'exact',         // classes that never appear without each other become one
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `names` | `'legacy'` | `'legacy'` and `'short'` are hashes a module can compute by itself. `'min'` names are given by the build, kept in `namesFile` and append-only: a class keeps its name from build to build |
| `granularity` | `'property'` | `'rule'`: one class per generated rule, so styles share the rules they have in common |
| `minify` | `false` | A stylesheet without white space, in which rules with the same declaration share one rule |
| `fuse` | `false` | With `names: 'min'`: `'exact'` fuses classes that are never applied apart and writes no rule twice; `'balanced'` also gives frequent pairs a class; `'max'` gives every group of classes one class |
| `namesFile` | `node_modules/.cache/purser/names.json` | Where minimal names are kept between builds. Name a file in the repository to keep class names stable across machines (and commit it) |
| `compile` | `true` with `names: 'min'`, else `false` | Compile modules with Purser's loader: `css.create` becomes class names, `css.props` a string expression, and the runtime leaves the bundle |

What `withHypDriv` does with `compile`:

- **Turbopack** (the default bundler) gets a rule for the project's own script modules: `condition: { all: [{ not: 'foreign' }, { content: /@avonao\/purser/ }] }`, so dependencies are never touched and a module that does not use Purser never starts the loader. With a custom `cssModule` the content condition is dropped, because such a module need not name the package.
- **webpack** (`next build --webpack`) gets the same loader as a `pre` rule, in front of your own `webpack()` function.
- The loader is given the naming options and the names file of the stylesheet build, so a class has one name in the stylesheet and in every module. With `fuse`, it reads the build's plan from Purser's cache directory.
- **`next build`** runs the stylesheet build first, as before; every name exists when the bundler starts. **`next dev`** keeps the watching build beside the bundler. A module with a new style can reach the loader before the watcher has named its classes; the loader waits for the name instead of failing. Classes are not fused in development: a fused class depends on every module, and a dev server compiles one at a time.
- A bundler that keeps compiled modules between builds (Turbopack's file system cache, webpack's) compiles them again when names are given anew, for example after `node_modules` was removed and with it the default names file, and not when a class is added.

The unstyled-atom guard, the usage report and `hypdriv audit css` know the naming in use: with minimal names every class inside the atoms layer of the stylesheet is an atom, whatever it is called.

What it is worth is measured in [Purser's benchmarks](https://github.com/avonao/purser/blob/main/docs/benchmarks.md): on its corpus of 500 components, stylesheet, script and markup together are about half the bytes of the runtime mode with `names: 'min'` and `fuse: 'exact'`, and no declaration is struck through in either.

`purser.names`, `granularity`, `minify`, `fuse` and `compile` need `@avonao/purser` 0.2 or later; with 0.1 installed the build stops and says which option asks for it.

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

`@avonao/purser` 0.2 and later bring their own parser (they depend on `typescript` 5 or 6 and use that copy when the project's has no parser API), so a project on TypeScript 7 needs nothing extra.

`@avonao/purser` 0.1 parses with the project's TypeScript, and TypeScript 7.0 ships without a programmatic API. `hypdriv doctor` detects that combination and recommends updating Purser, or installing TypeScript 6 under the `typescript` name (`"typescript": "npm:@typescript/typescript6@^6"`) for the build step; your editor can keep using 7.
