import {
  appendListHeader,
  defineStage,
  HEADER,
  isHtmlResponse,
  parseCookies,
  type ResolvedConfig,
  type Stage,
  type StateKey,
  stateKey,
} from '@hypdriv/core';
import {
  allThemeClasses,
  CLIENT_HINT_TOKENS,
  CRITICAL_CLIENT_HINTS,
  THEME_ATTRIBUTE,
  type ThemeConfig,
  themeClientHints,
} from './axes';
import {
  type CompiledTheme,
  compileTheme,
  type ResolvedTheme,
  resolveCompiledTheme,
  THEME_KEY,
} from './resolve';

/** The full resolution (values, classes, sources, header), for DevTools and the edge stages. */
export const THEME_RESOLVED_KEY: StateKey<ResolvedTheme> = stateKey<ResolvedTheme>('purser.theme.resolved');

/** The subset of `HTMLRewriter`'s element API the theme pin uses (structural, no Workers types). */
export interface HtmlRewriterElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): unknown;
  removeAttribute?(name: string): unknown;
}

export interface HtmlRewriterLike {
  on(
    selector: string,
    handlers: { element(element: HtmlRewriterElement): void | Promise<void> },
  ): HtmlRewriterLike;
  transform(response: Response): Response;
}

export type HtmlRewriterConstructor = new () => HtmlRewriterLike;

/** `globalThis.HTMLRewriter` when running on Cloudflare Workers (or a test fake), else `null`. */
export function getHtmlRewriter(): HtmlRewriterConstructor | null {
  const ctor = (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
  return typeof ctor === 'function' ? (ctor as HtmlRewriterConstructor) : null;
}

/**
 * Merges the resolved theme classes into an existing `class` attribute value: classes that belong to
 * any axis but were not selected are removed (the pin is authoritative), selected ones are appended
 * once, every other class is kept in place.
 */
export function mergeThemeClasses(
  existing: string | null,
  selected: readonly string[],
  known: ReadonlySet<string>,
): string {
  const current = (existing ?? '').split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const cls of current) {
    if (known.has(cls) && !selected.includes(cls)) continue;
    if (!kept.includes(cls)) kept.push(cls);
  }
  for (const cls of selected) if (!kept.includes(cls)) kept.push(cls);
  return kept.join(' ');
}

/** Element handler that pins the theme on `<html>`; exported for `@hypdriv/cloudflare`'s edge stages. */
export function themeElementHandler(resolved: ResolvedTheme, known: ReadonlySet<string>) {
  return {
    element(element: HtmlRewriterElement): void {
      const existing = element.getAttribute('class');
      const next = mergeThemeClasses(existing, resolved.classes, known);
      if (next !== (existing ?? '').trim()) {
        if (next === '' && element.removeAttribute) element.removeAttribute('class');
        else element.setAttribute('class', next);
      }
      element.setAttribute(THEME_ATTRIBUTE, resolved.header);
    },
  };
}

/** Pins the theme on an HTML response with HTMLRewriter. Returns the input when no rewriter exists. */
export function pinThemeResponse(
  response: Response,
  resolved: ResolvedTheme,
  known: ReadonlySet<string>,
): Response {
  const Rewriter = getHtmlRewriter();
  if (!Rewriter || !response.body) return response;
  return new Rewriter().on('html', themeElementHandler(resolved, known)).transform(response);
}

/**
 * Adds the negotiation headers to an HTML response: `Vary: Cookie` always (the document depends on
 * the theme cookie), and when client hints are accepted `Accept-CH` for the hints the axes use,
 * `Critical-CH` for the colour scheme (Chrome retries the first navigation with the hint, so even
 * the first paint is right) and `Vary` on those hints.
 */
export function applyThemeResponseHeaders(
  headers: Headers,
  theme: Pick<CompiledTheme, 'acceptClientHints' | 'axes'>,
): void {
  appendListHeader(headers, 'vary', 'Cookie');
  if (!theme.acceptClientHints) return;
  const hints = themeClientHints(theme.axes);
  if (!hints.length) return;
  const tokens = hints.map((h) => CLIENT_HINT_TOKENS[h]);
  appendListHeader(headers, 'accept-ch', tokens);
  const critical = hints.filter((h) => CRITICAL_CLIENT_HINTS.has(h)).map((h) => CLIENT_HINT_TOKENS[h]);
  if (critical.length) appendListHeader(headers, 'critical-ch', critical);
  appendListHeader(headers, 'vary', tokens);
}

/**
 * The `theme` stage (default order position 8, before `edge-cache`).
 *
 * - `pre`: resolves the axes from the theme cookie / client hints / defaults, stores them under
 *   {@link THEME_KEY} (values) and {@link THEME_RESOLVED_KEY} (full resolution) and forwards
 *   `x-hypdriv-theme: axis=value;…` to Next.js (`hyp().theme`).
 * - `post` (HTML responses only): pins the classes and `data-hypdriv-theme` on `<html>` through
 *   `HTMLRewriter` when the runtime has one (Workers), and adds `Vary` / `Accept-CH` / `Critical-CH`.
 *   Without HTMLRewriter (proxy, `next start`) it is header-only and the inline fallback script
 *   (`themeScriptTag`) applies the classes in the browser.
 *
 * Caching: the pin runs after `edge-cache`'s post, so cached bodies stay theme-neutral and are pinned
 * per request on the way out. Only when server components themselves read the theme (`hyp().theme`,
 * the `x-hypdriv-theme` header) must the matching edge-cache policy list the theme cookie under
 * `vary.cookies` (and the hint header under `vary.headers`).
 *
 * Skipped for RSC payload requests (`runOnRsc: false`): payloads carry no `<html>`; server code that
 * needs the theme on client navigations can call `resolveTheme()` on the request cookies.
 */
export function themeStage(config: ResolvedConfig): Stage {
  const themeConfig: ThemeConfig | null = config.purser?.theme ?? null;
  const theme = themeConfig ? compileTheme(themeConfig) : null;
  const known: ReadonlySet<string> = new Set(theme ? allThemeClasses(theme.axes) : []);

  const resolveFor = (request: Request): ResolvedTheme =>
    resolveCompiledTheme(theme!, {
      cookies: parseCookies(request.headers.get('cookie')),
      headers: request.headers,
    });

  return defineStage({
    name: 'theme',
    runOnRsc: false,
    pre(ctx) {
      if (!theme) return;
      const resolved = resolveFor(ctx.request);
      ctx.state.set(THEME_KEY, resolved.values);
      ctx.state.set(THEME_RESOLVED_KEY, resolved);
      ctx.requestHeaders.set(HEADER.theme, resolved.header);
    },
    post(ctx, response) {
      if (!theme || !isHtmlResponse(response)) return response;
      const resolved = ctx.state.get(THEME_RESOLVED_KEY) ?? resolveFor(ctx.request);
      const pinned = pinThemeResponse(response, resolved, known);
      const headers = new Headers(pinned.headers);
      applyThemeResponseHeaders(headers, theme);
      return new Response(pinned.body, { status: pinned.status, statusText: pinned.statusText, headers });
    },
  });
}
