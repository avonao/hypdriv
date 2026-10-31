import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { htmlPathname, normalizePathname, type PrerenderedDocument } from '@hypdriv/vite';

/** A prerendered HTML document in the client output, with its path relative to that directory. */
export interface StartDocument extends PrerenderedDocument {
  /** `about.html`, `docs/index.html`, `_shell.html` (forward slashes). */
  relative: string;
}

/**
 * The HTML documents in the client output after prerendering: Start's prerendered pages (`about.html`, or
 * `about/index.html` with `autoSubfolderIndex`), the SPA shell (`_shell.html`) and HTML files from `public/`.
 * Dot-directories (`.vite`) are skipped. Pathnames carry the router's base path.
 */
export function findDocuments(clientDir: string, basePath = ''): StartDocument[] {
  if (!existsSync(clientDir)) return [];
  const out: StartDocument[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.html')) {
        const rel = relative(clientDir, full).split(sep).join('/');
        out.push({
          pathname: normalizePathname(`${basePath}${htmlPathname(rel)}`),
          file: full,
          relative: rel,
        });
      }
    }
  };
  walk(clientDir);
  return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
}

const NONCE_META = /<meta\b[^>]*\bproperty\s*=\s*["']?csp-nonce\b/i;
const NONCE_ATTRIBUTE = /<(?:script|style|link)\b[^>]*\snonce\s*=\s*["'][^"']+["']/i;

/**
 * Documents that carry a CSP nonce: a sign that a per-request pipeline ran while Start prerendered them (the
 * prerender requests were not marked), which bakes one request's nonce, id and flags into a file served to everyone.
 */
export function documentsWithNonce(documents: PrerenderedDocument[]): string[] {
  const out: string[] = [];
  for (const doc of documents) {
    try {
      if (statSync(doc.file).size > 8 * 1024 * 1024) continue;
      const html = readFileSync(doc.file, 'utf8');
      if (NONCE_META.test(html) || NONCE_ATTRIBUTE.test(html)) out.push(doc.pathname);
    } catch {
      // unreadable: not ours to judge
    }
  }
  return out;
}
