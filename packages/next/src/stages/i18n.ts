import {
  type HypContext,
  type ResolvedConfig,
  type ResolvedI18n,
  type Stage,
  appendListHeader,
  defineStage,
  getCookie,
  isHtmlLike,
  isInternalPath,
  looksLikeStaticAsset,
  negotiateLanguage,
  redirect,
  stateKey,
} from '@hypdriv/core';
import { GEO_KEY } from './geo';

export const LOCALE_KEY = stateKey<{ locale: string; source: 'path' | 'cookie' | 'geo' | 'header' | 'default' }>('next.locale');

/** Splits a leading locale segment from a pathname when it is one of the configured locales. */
export function splitLocale(pathname: string, locales: string[]): { locale: string | null; rest: string } {
  const [, first = '', ...rest] = pathname.split('/');
  const hit = locales.find((l) => l.toLowerCase() === first.toLowerCase());
  if (!hit) return { locale: null, rest: pathname };
  return { locale: hit, rest: `/${rest.join('/')}`.replace(/\/+$/, '') || '/' };
}

/** Negotiates the locale for a request. */
export function negotiateLocale(config: ResolvedI18n, ctx: HypContext): { locale: string; source: 'path' | 'cookie' | 'geo' | 'header' | 'default' } {
  const { locale: fromPath } = splitLocale(ctx.url.pathname, config.locales);
  if (fromPath && config.strategy.startsWith('prefix')) return { locale: fromPath, source: 'path' };
  const cookie = getCookie(ctx.request.headers, config.cookie);
  if (cookie && config.locales.includes(cookie)) return { locale: cookie, source: 'cookie' };
  const country = ctx.state.get(GEO_KEY)?.country ?? ctx.request.headers.get('cf-ipcountry');
  if (country && config.geoMap[country] && config.locales.includes(config.geoMap[country]!)) return { locale: config.geoMap[country]!, source: 'geo' };
  const header = ctx.request.headers.get('accept-language');
  if (header) {
    const negotiated = negotiateLanguage(header, config.locales, config.defaultLocale);
    return { locale: negotiated, source: negotiated === config.defaultLocale && !header.toLowerCase().includes(config.defaultLocale.toLowerCase()) ? 'default' : 'header' };
  }
  return { locale: config.defaultLocale, source: 'default' };
}

/** Locale negotiation and prefix redirects (App Router has no built-in i18n routing). */
export function i18nStage(config: ResolvedConfig): Stage | null {
  const i18n = config.i18n;
  if (!i18n) return null;
  return defineStage({
    name: 'i18n',
    runOnRsc: true,
    pre(ctx) {
      const pathname = ctx.url.pathname;
      if (isInternalPath(pathname, config.cloudflare.internalPathPrefix) || looksLikeStaticAsset(pathname) || pathname.startsWith('/api/')) return;
      const result = negotiateLocale(i18n, ctx);
      ctx.state.set(LOCALE_KEY, result);
      ctx.requestHeaders.set(i18n.header, result.locale);
      if (result.source === 'header') ctx.responseHeaders.append('vary', 'Accept-Language');
      if (!i18n.redirect || ctx.request.method !== 'GET') return;
      const { locale: prefixed } = splitLocale(pathname, i18n.locales);
      if (prefixed) return;
      const needsPrefix = i18n.strategy === 'prefix' || (i18n.strategy === 'prefix-except-default' && result.locale !== i18n.defaultLocale);
      if (!needsPrefix) return;
      const target = new URL(ctx.url.href);
      target.pathname = `/${result.locale}${pathname === '/' ? '' : pathname}`;
      const res = redirect(target, 307, { 'cache-control': 'private, no-store' });
      appendListHeader(res.headers, 'vary', ['Accept-Language', 'Cookie']);
      return res;
    },
    post(ctx, response) {
      const result = ctx.state.get(LOCALE_KEY);
      if (!result || response.headers.has('content-language')) return response;
      if (!isHtmlLike(ctx, response)) return response;
      const headers = new Headers(response.headers);
      headers.set('content-language', result.locale);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  });
}
