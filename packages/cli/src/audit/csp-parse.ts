import type { CspDirectives } from '@hypdriv/core';

/** Local CSP parser (identical semantics to `parseCsp` in @hypdriv/security; keeps audits dependency-free). */
export function parseCspLocal(header: string | null | undefined): CspDirectives {
  const out: CspDirectives = {};
  if (!header) return out;
  for (const raw of header.split(';')) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    const name = tokens.shift()?.toLowerCase();
    if (!name || name in out) continue;
    if (name === 'upgrade-insecure-requests' || name === 'block-all-mixed-content') {
      out[name] = true;
      continue;
    }
    out[name] = tokens;
  }
  return out;
}

/** Nonce from `script-src` (or `script-src-elem` / `default-src`). */
export function nonceOf(directives: CspDirectives): string | null {
  for (const d of ['script-src', 'script-src-elem', 'default-src']) {
    const list = directives[d];
    if (!Array.isArray(list)) continue;
    for (const src of list) {
      const m = /^'nonce-([A-Za-z0-9+/_=-]+)'$/.exec(src);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

/** `sha256-…` hash sources from `script-src` (quotes stripped). */
export function scriptHashesOf(directives: CspDirectives): string[] {
  const out: string[] = [];
  for (const d of ['script-src', 'script-src-elem', 'default-src']) {
    const list = directives[d];
    if (!Array.isArray(list)) continue;
    for (const src of list) {
      const m = /^'(sha(?:256|384|512)-[A-Za-z0-9+/=]+)'$/.exec(src);
      if (m?.[1]) out.push(m[1]);
    }
    if (out.length) break;
  }
  return out;
}

/** Effective `script-src` list (falls back to `default-src`). */
export function scriptSources(directives: CspDirectives): string[] {
  const own = directives['script-src'] ?? directives['script-src-elem'] ?? directives['default-src'];
  return Array.isArray(own) ? own : [];
}

const EXECUTABLE_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'module',
  'speculationrules',
  'importmap',
]);
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export interface ScriptTag {
  attrs: Record<string, string>;
  content: string;
  inline: boolean;
  executable: boolean;
}

/** Tokenises `<script>` elements of a document (attribute map plus inline body). */
export function scriptTags(html: string): ScriptTag[] {
  const out: ScriptTag[] = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[1] ?? '').matchAll(ATTR_RE)) {
      const name = a[1]?.toLowerCase();
      if (name) attrs[name] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    const type = (attrs.type ?? '').trim().toLowerCase();
    const inline = attrs.src === undefined;
    out.push({ attrs, content: m[2] ?? '', inline, executable: EXECUTABLE_TYPES.has(type) });
  }
  return out;
}

/** Inline executable script bodies (fallback for `extractInlineScripts` from @hypdriv/next/adapter). */
export function inlineScriptsLocal(html: string): string[] {
  return scriptTags(html)
    .filter((t) => t.inline && t.executable)
    .map((t) => t.content);
}
