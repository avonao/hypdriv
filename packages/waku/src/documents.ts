import { type Dirent, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrerenderedDocument } from '@hypdriv/vite';

export interface FindDocumentsOptions {
  /** Top-level directories of the client output that hold no documents (`assets`, the RSC payload directory). */
  skip?: string[];
}

/**
 * The HTML documents Waku prerendered into the client output (`dist/public`): one `index.html` per static path
 * (`/` → `index.html`, `/about` → `about/index.html`, `/blog/a` → `blog/a/index.html`). Other `.html` files are
 * the application's own public files, served as they are.
 */
export function findDocuments(clientDir: string, options: FindDocumentsOptions = {}): PrerenderedDocument[] {
  const skip = new Set(['.vite', '.hypdriv', 'node_modules', ...(options.skip ?? [])]);
  const documents: PrerenderedDocument[] = [];
  const walk = (dir: string, segments: string[]) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (segments.length === 0 && skip.has(entry.name)) continue;
        walk(join(dir, entry.name), [...segments, entry.name]);
      } else if (entry.isFile() && entry.name === 'index.html') {
        documents.push({ pathname: `/${segments.join('/')}`, file: join(dir, entry.name) });
      }
    }
  };
  walk(clientDir, []);
  return documents.sort((a, b) => a.pathname.localeCompare(b.pathname));
}

/** The path of a document inside the static output (`/about` → `about/index.html`). */
export function documentFile(pathname: string): string {
  return pathname === '/' ? 'index.html' : `${pathname.replace(/^\/+|\/+$/g, '')}/index.html`;
}
