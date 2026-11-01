import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { htmlPathname, normalizePathname, type PrerenderedDocument } from '@hypdriv/vite';

/** A prerendered HTML document in the public output, with its path relative to that directory. */
export interface StartDocument extends PrerenderedDocument {
  /** `index.html`, `about/index.html`, `docs.html` (forward slashes). */
  relative: string;
}

/**
 * The HTML documents in Nitro's public output after prerendering (`.output/public`, `.vercel/output/static`, or the
 * client build's directory): the pages Nitro prerendered (`about/index.html`) and HTML files from `public/`.
 * Dot-directories (`.vite`) are skipped. Pathnames carry the app's base path.
 */
export function findDocuments(publicDir: string, basePath = ''): StartDocument[] {
  if (!existsSync(publicDir)) return [];
  const out: StartDocument[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.html')) {
        const rel = relative(publicDir, full).split(sep).join('/');
        out.push({
          pathname: normalizePathname(`${basePath}${htmlPathname(rel)}`),
          file: full,
          relative: rel,
        });
      }
    }
  };
  walk(publicDir);
  return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
}

const NONCE_ATTRIBUTE = /<(?:script|style|link)\b[^>]*\snonce\s*=\s*["'][^"']+["']/i;

/**
 * Documents that carry a CSP nonce: a sign that a per-request pipeline ran while Nitro prerendered them, which
 * bakes one request's nonce into a file served to everyone.
 */
export function documentsWithNonce(documents: PrerenderedDocument[]): string[] {
  const out: string[] = [];
  for (const doc of documents) {
    try {
      if (statSync(doc.file).size > 8 * 1024 * 1024) continue;
      if (NONCE_ATTRIBUTE.test(readFileSync(doc.file, 'utf8'))) out.push(doc.pathname);
    } catch {
      // unreadable: not ours to judge
    }
  }
  return out;
}
