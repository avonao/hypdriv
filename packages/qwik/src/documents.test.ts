import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDocuments } from './documents';

const roots: string[] = [];

function tree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-qwik-docs-'));
  roots.push(root);
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '<!doctype html>');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('findDocuments', () => {
  it('returns one document per generated path, sorted', () => {
    const root = tree(['index.html', 'about/index.html', 'blog/hello/index.html', 'blog/qwik/index.html']);
    expect(findDocuments(root).map((d) => d.pathname)).toEqual(['/', '/about', '/blog/hello', '/blog/qwik']);
  });

  it('points at the file of each document', () => {
    const root = tree(['about/index.html']);
    expect(findDocuments(root)).toEqual([{ pathname: '/about', file: join(root, 'about', 'index.html') }]);
  });

  it('skips build output, tooling directories and files that are not directory indexes', () => {
    const root = tree([
      'index.html',
      'build/index.html',
      'assets/index.html',
      '.vite/index.html',
      '.hypdriv/index.html',
      'node_modules/pkg/index.html',
      'legacy.html',
      'sitemap.xml',
    ]);
    expect(findDocuments(root, { skip: ['build', 'assets'] }).map((d) => d.pathname)).toEqual(['/']);
  });

  it('only skips the named directories at the top level', () => {
    const root = tree(['docs/build/index.html']);
    expect(findDocuments(root, { skip: ['build'] }).map((d) => d.pathname)).toEqual(['/docs/build']);
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(findDocuments(join(tmpdir(), 'hypdriv-qwik-docs-missing'))).toEqual([]);
  });
});
