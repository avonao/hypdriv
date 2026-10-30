import { type StateKey, stateKey } from '@hypdriv/core';
import {
  CLIENT_HINT_HEADERS,
  encodeThemeValues,
  parseThemeCookie,
  type ThemeAxis,
  type ThemeConfig,
  themeAxes,
} from './axes';

/** Per-request theme values (axis → value), written by the `theme` stage. */
export const THEME_KEY: StateKey<Record<string, string>> = stateKey<Record<string, string>>('purser.theme');

/** Where an axis value came from. */
export type ThemeSource = 'cookie' | 'hint' | 'default';

export interface ResolvedTheme {
  /** Axis name → chosen value. */
  values: Record<string, string>;
  /** Class names to set on `<html>`: the non-null class of every axis in canonical axis order, de-duplicated. */
  classes: string[];
  /** Axis name → how the value was decided. */
  sources: Record<string, ThemeSource>;
  /** `axis=value;axis2=value2`: the `x-hypdriv-theme` header and `data-hypdriv-theme` attribute value. */
  header: string;
}

export interface ResolveThemeInput {
  /** Parsed request cookies (`parseCookies(request.headers.get('cookie'))` from `@hypdriv/core`). */
  cookies: Record<string, string>;
  headers: Headers;
}

/** A theme configuration validated once and ready for per-request resolution. */
export interface CompiledTheme {
  readonly cookie: string;
  readonly axes: readonly ThemeAxis[];
  readonly acceptClientHints: boolean;
  readonly fallbackScript: boolean;
}

/** Validates the theme configuration and sorts its axes (see {@link themeAxes}). */
export function compileTheme(theme: ThemeConfig): CompiledTheme {
  return {
    cookie: theme.cookie,
    axes: themeAxes(theme),
    acceptClientHints: theme.acceptClientHints,
    fallbackScript: theme.fallbackScript,
  };
}

/**
 * Resolves every theme axis for a request. Order per axis: a valid value in the theme cookie
 * (`axis=value;…`, URL-encoded) wins; otherwise, when `acceptClientHints` is on, the matching
 * `Sec-CH-Prefers-*` request header mapped through `clientHint.values`; otherwise the axis default.
 * Unknown values are ignored at each step. Pure and runtime-neutral.
 */
export function resolveTheme(theme: ThemeConfig, input: ResolveThemeInput): ResolvedTheme {
  return resolveCompiledTheme(compileTheme(theme), input);
}

/** Same as {@link resolveTheme} for a theme compiled once (the stage's hot path). */
export function resolveCompiledTheme(theme: CompiledTheme, input: ResolveThemeInput): ResolvedTheme {
  const pairs = parseThemeCookie(input.cookies[theme.cookie], theme.axes);
  const values: Record<string, string> = {};
  const sources: Record<string, ThemeSource> = {};
  const classes: string[] = [];
  for (const axis of theme.axes) {
    let value: string | undefined;
    let source: ThemeSource = 'default';
    const fromCookie = pairs[axis.cookie];
    if (fromCookie !== undefined && Object.hasOwn(axis.classes, fromCookie)) {
      value = fromCookie;
      source = 'cookie';
    } else if (theme.acceptClientHints && axis.clientHint) {
      const raw = input.headers.get(CLIENT_HINT_HEADERS[axis.clientHint.hint]);
      if (raw) {
        const mapped = axis.clientHint.values[normalizeHintValue(raw)];
        if (mapped !== undefined && Object.hasOwn(axis.classes, mapped)) {
          value = mapped;
          source = 'hint';
        }
      }
    }
    if (value === undefined) value = axis.default;
    values[axis.name] = value;
    sources[axis.name] = source;
    const cls = axis.classes[value];
    if (cls && !classes.includes(cls)) classes.push(cls);
  }
  return { values, classes, sources, header: encodeThemeValues(values, theme.axes) };
}

/** Structured-header token normalisation: trims, strips quotes, lower-cases (`"Dark"` → `dark`). */
function normalizeHintValue(raw: string): string {
  return raw
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim()
    .toLowerCase();
}
