import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { documentFile, findDocuments } from './documents';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function publicDir(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-waku-public-'));
  dirs.push(root);
  for (const name of files) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, name.endsWith('.html') ? '<!DOCTYPE html><html></html>' : 'x');
  }
  return root;
}

describe('findDocuments', () => {
  it('finds the index.html of every prerendered path', () => {
    const dir = publicDir([
      'index.html',
      'about/index.html',
      'blog/a/index.html',
      'blog/b/index.html',
      'RSC/R/about.txt',
      'RSC/R/blog/a.txt',
      'assets/index-abc.js',
      'robots.txt',
    ]);
    const documents = findDocuments(dir, { skip: ['assets', 'RSC'] });
    expect(documents.map((d) => d.pathname)).toEqual(['/', '/about', '/blog/a', '/blog/b']);
    expect(documents[1]?.file).toBe(join(dir, 'about', 'index.html'));
  });

  it('leaves the application’s own public .html files alone', () => {
    const dir = publicDir(['index.html', 'legacy.html', 'googlehash.html', 'docs/index.html']);
    expect(findDocuments(dir).map((d) => d.pathname)).toEqual(['/', '/docs']);
  });

  it('skips build metadata and the configured directories, but only at the top level', () => {
    const dir = publicDir([
      '.vite/manifest.json',
      '.hypdriv/manifest.json',
      'assets/index.html',
      'blog/assets/index.html',
    ]);
    expect(findDocuments(dir, { skip: ['assets'] }).map((d) => d.pathname)).toEqual(['/blog/assets']);
  });

  it('returns nothing for a missing directory', () => {
    expect(findDocuments(join(tmpdir(), 'hypdriv-waku-does-not-exist'))).toEqual([]);
  });
});

describe('documentFile', () => {
  it('maps a path to its file in the static output', () => {
    expect(documentFile('/')).toBe('index.html');
    expect(documentFile('/about')).toBe('about/index.html');
    expect(documentFile('/blog/a/')).toBe('blog/a/index.html');
  });
});
