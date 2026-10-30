import { HypDrivError, type ResolvedPurser } from '@hypdriv/core';

/** The resolved theme section of `hypdriv.config.ts` (`config.purser.theme`). */
export type ThemeConfig = NonNullable<ResolvedPurser['theme']>;

/** One resolved axis as configured (`config.purser.theme.axes[name]`). */
export type ThemeAxisConfig = ThemeConfig['axes'][string];

/** Client hints Purser themes can read (`PurserThemeAxis.clientHint.hint`). */
export type ClientHintName = 'prefers-color-scheme' | 'prefers-contrast' | 'prefers-reduced-motion';

/** Lower-case request header name carrying each client hint. */
export const CLIENT_HINT_HEADERS: Record<ClientHintName, string> = {
  'prefers-color-scheme': 'sec-ch-prefers-color-scheme',
  'prefers-contrast': 'sec-ch-prefers-contrast',
  'prefers-reduced-motion': 'sec-ch-prefers-reduced-motion',
};

/** Canonical spelling of each hint for `Accept-CH`, `Critical-CH` and `Vary`. */
export const CLIENT_HINT_TOKENS: Record<ClientHintName, string> = {
  'prefers-color-scheme': 'Sec-CH-Prefers-Color-Scheme',
  'prefers-contrast': 'Sec-CH-Prefers-Contrast',
  'prefers-reduced-motion': 'Sec-CH-Prefers-Reduced-Motion',
};

/** Hints worth a `Critical-CH` retry on the first navigation: only the colour scheme decides paint. */
export const CRITICAL_CLIENT_HINTS: ReadonlySet<ClientHintName> = new Set<ClientHintName>([
  'prefers-color-scheme',
]);

/** The attribute the edge pin and the fallback script set on `<html>` (value: `axis=value;axis2=value2`). */
export const THEME_ATTRIBUTE = 'data-hypdriv-theme';

/** A theme axis in canonical form: name, cookie key, class map, default and optional client hint. */
export interface ThemeAxis {
  readonly name: string;
  /** Key of the axis inside the theme cookie (`axis.cookie`, defaults to the axis name). */
  readonly cookie: string;
  readonly classes: Readonly<Record<string, string | null>>;
  readonly default: string;
  readonly clientHint: { hint: ClientHintName; values: Readonly<Record<string, string>> } | null;
}

const TOKEN_RE = /^[A-Za-z0-9_.:@/-]+$/;
const CLASS_RE = /^[^\s"'<>&=;,]+$/;

/**
 * Canonical, validated list of axes sorted by name. Every consumer (resolver, edge pin, fallback
 * script, forwarded header) iterates axes in this order, which makes the `x-hypdriv-theme` header,
 * the `data-hypdriv-theme` attribute, the class list and the inline script deterministic for equal
 * configuration regardless of object key order.
 *
 * @throws HypDrivError `E_CONFIG` when a name, cookie key, value or class cannot be represented in
 * a cookie pair, a class attribute or an inline script.
 */
export function themeAxes(theme: ThemeConfig): ThemeAxis[] {
  if (!theme.cookie || !TOKEN_RE.test(theme.cookie) || /[=;,]/.test(theme.cookie))
    throw new HypDrivError('E_CONFIG', `purser.theme.cookie: "${theme.cookie}" is not a valid cookie name`);
  const names = Object.keys(theme.axes).sort();
  if (names.length === 0)
    throw new HypDrivError('E_CONFIG', 'purser.theme.axes: at least one axis is required');
  const out: ThemeAxis[] = [];
  const cookieKeys = new Set<string>();
  for (const name of names) {
    const axis = theme.axes[name]!;
    const path = `purser.theme.axes.${name}`;
    if (!TOKEN_RE.test(name) || /[=;,]/.test(name))
      throw new HypDrivError('E_CONFIG', `${path}: axis names must be cookie-safe tokens`);
    const cookie = axis.cookie || name;
    if (!TOKEN_RE.test(cookie) || /[=;,]/.test(cookie))
      throw new HypDrivError('E_CONFIG', `${path}.cookie: "${cookie}" is not a cookie-safe key`);
    if (cookieKeys.has(cookie))
      throw new HypDrivError('E_CONFIG', `${path}.cookie: key "${cookie}" is used by another axis`);
    cookieKeys.add(cookie);
    const values = Object.keys(axis.classes);
    if (values.length === 0)
      throw new HypDrivError('E_CONFIG', `${path}.classes: at least one value is required`);
    for (const value of values) {
      if (!TOKEN_RE.test(value) || /[=;,]/.test(value))
        throw new HypDrivError('E_CONFIG', `${path}.classes: value "${value}" is not cookie-safe`);
      const cls = axis.classes[value];
      if (cls !== null && (typeof cls !== 'string' || !CLASS_RE.test(cls)))
        throw new HypDrivError(
          'E_CONFIG',
          `${path}.classes.${value}: "${String(cls)}" is not a single class name`,
        );
    }
    if (!(axis.default in axis.classes))
      throw new HypDrivError(
        'E_CONFIG',
        `${path}.default: "${axis.default}" is not one of ${values.join(', ')}`,
      );
    let clientHint: ThemeAxis['clientHint'] = null;
    if (axis.clientHint) {
      const hint = axis.clientHint.hint;
      if (!(hint in CLIENT_HINT_HEADERS))
        throw new HypDrivError('E_CONFIG', `${path}.clientHint.hint: unknown hint "${String(hint)}"`);
      const mapped: Record<string, string> = {};
      for (const key of Object.keys(axis.clientHint.values).sort()) {
        const target = axis.clientHint.values[key]!;
        if (!TOKEN_RE.test(key))
          throw new HypDrivError('E_CONFIG', `${path}.clientHint.values: "${key}" is not a hint value`);
        if (!(target in axis.classes))
          throw new HypDrivError(
            'E_CONFIG',
            `${path}.clientHint.values.${key}: "${target}" is not one of ${values.join(', ')}`,
          );
        mapped[key] = target;
      }
      clientHint = { hint, values: mapped };
    }
    out.push({ name, cookie, classes: { ...axis.classes }, default: axis.default, clientHint });
  }
  return out;
}

/** Every class name any axis can set, in axis order, without duplicates. */
export function allThemeClasses(axes: readonly ThemeAxis[]): string[] {
  const out: string[] = [];
  for (const axis of axes)
    for (const cls of Object.values(axis.classes)) if (cls && !out.includes(cls)) out.push(cls);
  return out;
}

/** Distinct client hints referenced by the axes, in axis order. */
export function themeClientHints(axes: readonly ThemeAxis[]): ClientHintName[] {
  const out: ClientHintName[] = [];
  for (const axis of axes)
    if (axis.clientHint && !out.includes(axis.clientHint.hint)) out.push(axis.clientHint.hint);
  return out;
}

/**
 * Parses the decoded theme cookie value (`mode=dark;contrast=high`) into raw cookie-key → value pairs.
 * A segment without `=` is accepted as the value of the only axis when exactly one axis exists
 * (`hyp_theme=dark`); segments are trimmed and later duplicates win.
 */
export function parseThemeCookie(
  value: string | undefined | null,
  axes: readonly ThemeAxis[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const segment of value.split(';')) {
    const idx = segment.indexOf('=');
    if (idx > 0) {
      const key = segment.slice(0, idx).trim();
      if (key) out[key] = segment.slice(idx + 1).trim();
    } else if (idx === -1 && axes.length === 1 && segment.trim()) {
      out[axes[0]!.cookie] = segment.trim();
    }
  }
  return out;
}

/** Serialises axis values as `axis=value;axis2=value2` in canonical axis order. */
export function encodeThemeValues(
  values: Readonly<Record<string, string>>,
  axes: readonly ThemeAxis[],
): string {
  return axes
    .filter((axis) => values[axis.name] !== undefined)
    .map((axis) => `${axis.name}=${values[axis.name]}`)
    .join(';');
}

/**
 * Parses the `x-hypdriv-theme` request header (or the `data-hypdriv-theme` attribute) back into
 * axis → value pairs. Returns an empty object for a missing header.
 */
export function decodeThemeHeader(value: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const segment of value.split(';')) {
    const idx = segment.indexOf('=');
    if (idx <= 0) continue;
    const key = segment.slice(0, idx).trim();
    if (key) out[key] = segment.slice(idx + 1).trim();
  }
  return out;
}

/** The `Set-Cookie`-ready value for a theme choice: URL-encoded `axis=value;…` pairs. */
export function encodeThemeCookieValue(
  values: Readonly<Record<string, string>>,
  axes: readonly ThemeAxis[],
): string {
  return encodeURIComponent(encodeThemeValues(values, axes));
}
