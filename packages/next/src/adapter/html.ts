/**
 * Small, dependency-free extraction helpers for server-rendered HTML. React's SSR output is
 * regular (quoted attributes, no exotic nesting), so a tag/attribute tokenizer is sufficient.
 */

export interface HtmlTag {
  name: string;
  attrs: Record<string, string>;
  /** Inner text for script/style elements. */
  content?: string;
  start: number;
  end: number;
}

const TAG_RE = /<(script|style|link|a|meta|html|body)\b([^>]*)>/gi;
const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1]?.toLowerCase();
    if (!name) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Tokenises the interesting tags of a document in order. */
export function scanTags(html: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null = TAG_RE.exec(html);
  while (m) {
    const name = m[1]!.toLowerCase();
    const attrs = parseAttrs(m[2] ?? '');
    const tag: HtmlTag = { name, attrs, start: m.index, end: TAG_RE.lastIndex };
    if (name === 'script' || name === 'style') {
      const close = html.indexOf(`</${name}`, TAG_RE.lastIndex);
      if (close !== -1) {
        tag.content = html.slice(TAG_RE.lastIndex, close);
        tag.end = close;
        TAG_RE.lastIndex = close;
      }
    }
    tags.push(tag);
    m = TAG_RE.exec(html);
  }
  return tags;
}

const EXECUTABLE_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'module',
  'speculationrules',
  'importmap',
]);

/** Inline `<script>` bodies that CSP `script-src` governs (executable types only, no `src`). */
export function extractInlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const t of scanTags(html)) {
    if (t.name !== 'script' || t.attrs.src !== undefined || t.content === undefined) continue;
    const type = (t.attrs.type ?? '').trim().toLowerCase();
    if (!EXECUTABLE_TYPES.has(type)) continue;
    out.push(t.content);
  }
  return out;
}

/** Inline `<style>` bodies. */
export function extractInlineStyles(html: string): string[] {
  const out: string[] = [];
  for (const t of scanTags(html)) if (t.name === 'style' && t.content !== undefined) out.push(t.content);
  return out;
}

export interface HtmlAssets {
  stylesheets: string[];
  scripts: string[];
  modulePreloads: string[];
  preloads: Array<{ href: string; as: string; type?: string; crossorigin?: string }>;
  fonts: Array<{ href: string; type?: string }>;
  /** `<link rel="preconnect">` hosts already present in the document. */
  preconnects: string[];
}

/** Resource references in the document head/body. */
export function extractAssets(html: string): HtmlAssets {
  const assets: HtmlAssets = {
    stylesheets: [],
    scripts: [],
    modulePreloads: [],
    preloads: [],
    fonts: [],
    preconnects: [],
  };
  const push = (list: string[], value: string | undefined) => {
    if (value && !list.includes(value)) list.push(value);
  };
  for (const t of scanTags(html)) {
    if (t.name === 'script' && t.attrs.src) push(assets.scripts, t.attrs.src);
    if (t.name !== 'link') continue;
    const rel = (t.attrs.rel ?? '').toLowerCase().split(/\s+/);
    const href = t.attrs.href;
    if (!href) continue;
    if (rel.includes('stylesheet')) push(assets.stylesheets, href);
    else if (rel.includes('modulepreload')) push(assets.modulePreloads, href);
    else if (rel.includes('preconnect')) push(assets.preconnects, href);
    else if (rel.includes('preload')) {
      const as = (t.attrs.as ?? '').toLowerCase();
      if (!assets.preloads.some((p) => p.href === href)) {
        assets.preloads.push({
          href,
          as,
          ...(t.attrs.type ? { type: t.attrs.type } : {}),
          ...(t.attrs.crossorigin !== undefined ? { crossorigin: t.attrs.crossorigin } : {}),
        });
      }
      if (as === 'font' && !assets.fonts.some((f) => f.href === href))
        assets.fonts.push({ href, ...(t.attrs.type ? { type: t.attrs.type } : {}) });
    }
  }
  return assets;
}

/** Same-origin navigation targets (`<a href>`), normalised to pathnames, de-duplicated and ordered. */
export function extractLinks(html: string, options: { origin?: string; basePath?: string } = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of scanTags(html)) {
    if (t.name !== 'a') continue;
    const href = t.attrs.href;
    if (!href) continue;
    const lower = href.toLowerCase();
    if (
      lower.startsWith('mailto:') ||
      lower.startsWith('tel:') ||
      lower.startsWith('javascript:') ||
      lower.startsWith('#') ||
      lower.startsWith('data:')
    )
      continue;
    let pathname: string;
    if (href.startsWith('/') && !href.startsWith('//')) pathname = href;
    else {
      try {
        const u = new URL(href);
        if (options.origin && u.origin !== options.origin) continue;
        if (!options.origin) continue;
        pathname = u.pathname;
      } catch {
        continue;
      }
    }
    pathname = pathname.split('#')[0]!.split('?')[0]!;
    if (!pathname || seen.has(pathname)) continue;
    if (t.attrs.rel?.split(/\s+/).includes('nofollow')) continue;
    if (t.attrs.download !== undefined) continue;
    seen.add(pathname);
    out.push(pathname);
  }
  return out;
}

/** Extracts the `<html>` element attributes (lang, class). */
export function extractHtmlAttributes(html: string): Record<string, string> {
  const tag = scanTags(html).find((t) => t.name === 'html');
  return tag?.attrs ?? {};
}

/** `<meta name=... content=...>` map. */
export function extractMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of scanTags(html)) {
    if (t.name !== 'meta') continue;
    const name = t.attrs.name ?? t.attrs.property;
    if (name && t.attrs.content !== undefined) out[name] = t.attrs.content;
  }
  return out;
}
