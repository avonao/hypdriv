import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { documentsWithNonce, findDocuments } from './documents';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function publicDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-solid-public-'));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

const HTML = '<!DOCTYPE html><html><body><script>boot()</script></body></html>';

describe('findDocuments', () => {
  it('finds the documents Nitro prerendered, at their clean paths', () => {
    const dir = publicDir({
      'index.html': HTML,
      'about/index.html': HTML,
      'blog/a/index.html': HTML,
      'docs.html': HTML,
      '_build/assets/entry-abc.js': 'x',
      'robots.txt': 'x',
    });
    const documents = findDocuments(dir);
    expect(documents.map((d) => d.pathname)).toEqual(['/', '/about', '/blog/a', '/docs']);
    expect(documents.map((d) => d.relative)).toEqual([
      'index.html',
      'about/index.html',
      'blog/a/index.html',
      'docs.html',
    ]);
    expect(documents[1]?.file).toBe(join(dir, 'about', 'index.html'));
  });

  it('skips build metadata directories', () => {
    const dir = publicDir({ '.vite/index.html': HTML, '.hypdriv/x.html': HTML, 'index.html': HTML });
    expect(findDocuments(dir).map((d) => d.pathname)).toEqual(['/']);
  });

  it('prefixes the base path', () => {
    const dir = publicDir({ 'index.html': HTML, 'about/index.html': HTML });
    expect(findDocuments(dir, '/app').map((d) => d.pathname)).toEqual(['/app', '/app/about']);
  });

  it('returns nothing for a missing directory', () => {
    expect(findDocuments(join(tmpdir(), 'hypdriv-solid-does-not-exist'))).toEqual([]);
  });
});

describe('documentsWithNonce', () => {
  it('reports documents with a baked-in nonce (a pipeline that ran during prerendering)', () => {
    const dir = publicDir({
      'index.html': HTML,
      'leaked/index.html': '<html><script nonce="abc123">boot()</script></html>',
      'style/index.html': "<html><style nonce='abc'>a{}</style></html>",
      'link/index.html': '<html><link rel="preload" nonce="n1" href="/x.js"></html>',
      'text/index.html': '<html><p>the word nonce="x" in text</p></html>',
    });
    expect(documentsWithNonce(findDocuments(dir))).toEqual(['/leaked', '/link', '/style']);
  });

  it('ignores unreadable files', () => {
    expect(
      documentsWithNonce([{ pathname: '/gone', file: join(tmpdir(), 'hypdriv-solid-gone.html') }]),
    ).toEqual([]);
  });
});
