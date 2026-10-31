import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HypManifest } from '@hypdriv/core';
import type { PrerenderedDocument } from '@hypdriv/vite';

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/**
 * Rewrites relative `href` / `src` attributes of `<link>` and `<script>` tags (SvelteKit's default
 * `paths.relative: true` writes `./_app/…` and `../_app/…`) to root-relative paths resolved against the document's
 * URL, so asset discovery and Early Hints see the URLs the browser requests. Inline script and style contents are
 * never touched (their CSP hashes must stay those of the served file).
 */
export function absolutizeAssetUrls(html: string, pathname: string): string {
  const base = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, 'https://hypdriv.invalid');
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end === -1 ? html.length : end + 3;
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    const tag = /^<([a-zA-Z][a-zA-Z0-9-]*)\b/.exec(html.slice(lt, lt + 64));
    if (!tag) {
      out += html.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }
    const name = tag[1]!.toLowerCase();
    const close = findTagEnd(html, lt);
    let open = html.slice(lt, close);
    if (name === 'link' || name === 'script') open = rewriteAttributes(open, base);
    out += html.slice(i, lt) + open;
    i = close;
    if (RAW_TEXT.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, i);
      const stop = end === -1 ? html.length : end;
      out += html.slice(i, stop);
      i = stop;
    }
  }
  return out + html.slice(i);
}

/** Index just past the `>` that closes the tag opened at `start` (quote-aware). */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let j = start + 1; j < html.length; j++) {
    const ch = html[j];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return j + 1;
  }
  return html.length;
}

function rewriteAttributes(open: string, base: URL): string {
  return open.replace(
    /(\s(?:href|src)\s*=\s*)(["'])(\.{1,2}\/[^"']*)\2/gi,
    (_, prefix: string, quote: string, value: string) => {
      const resolved = new URL(value, base);
      return `${prefix}${quote}${resolved.pathname}${resolved.search}${resolved.hash}${quote}`;
    },
  );
}

/** CSP hashes of a `<meta http-equiv="content-security-policy">` policy SvelteKit writes into prerendered pages. */
export function metaCspHashes(html: string): { scriptHashes: string[]; styleHashes: string[] } {
  const scriptHashes = new Set<string>();
  const styleHashes = new Set<string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/http-equiv\s*=\s*["']?content-security-policy["'\s>]/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const policy = decodeEntities(content?.[1] ?? content?.[2] ?? '');
    for (const part of policy.split(';')) {
      const [directive, ...sources] = part.trim().split(/\s+/);
      const target = /^(?:script-src|script-src-elem|default-src)$/i.test(directive ?? '')
        ? scriptHashes
        : /^(?:style-src|style-src-elem)$/i.test(directive ?? '')
          ? styleHashes
          : null;
      if (!target) continue;
      for (const s of sources) if (/^'sha(?:256|384|512)-[A-Za-z0-9+/=]+'$/.test(s)) target.add(s);
    }
  }
  return { scriptHashes: [...scriptHashes], styleHashes: [...styleHashes] };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&amp;/gi, '&');
}

/**
 * Adds the hashes of SvelteKit's own `<meta>` policy to the manifest's CSP entries of the prerendered documents:
 * browsers enforce the meta policy and Hypdriv's header policy together, so the header must allow everything the
 * meta tag allows. Returns the number of documents whose entry changed.
 */
export function mergeMetaHashes(
  manifest: HypManifest,
  documents: Array<{ routeId: string; pathname: string; html: string }>,
): number {
  let changed = 0;
  for (const doc of documents) {
    const meta = metaCspHashes(doc.html);
    if (!meta.scriptHashes.length && !meta.styleHashes.length) continue;
    const key = manifest.csp[`${doc.routeId}#${doc.pathname}`]
      ? `${doc.routeId}#${doc.pathname}`
      : doc.routeId;
    const entry = manifest.csp[key];
    if (!entry) continue;
    const scripts = [...new Set([...entry.scriptHashes, ...meta.scriptHashes])];
    const styles = [...new Set([...entry.styleHashes, ...meta.styleHashes])];
    if (scripts.length !== entry.scriptHashes.length || styles.length !== entry.styleHashes.length) {
      manifest.csp[key] = { scriptHashes: scripts, styleHashes: styles };
      changed++;
    }
  }
  return changed;
}

/**
 * Copies SvelteKit's prerendered pages into `dir` with root-relative asset URLs (see `absolutizeAssetUrls`), for
 * manifest finalisation. The originals (what the platform serves) are left as they are.
 */
export function stageDocuments(
  pages: Iterable<readonly [string, { file: string }]>,
  sourceDir: string,
  dir: string,
): PrerenderedDocument[] {
  rmSync(dir, { recursive: true, force: true });
  const out: PrerenderedDocument[] = [];
  for (const [pathname, { file }] of pages) {
    let html: string;
    try {
      html = readFileSync(join(sourceDir, file), 'utf8');
    } catch {
      continue;
    }
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, absolutizeAssetUrls(html, pathname));
    out.push({ pathname, file: target });
  }
  return out;
}
