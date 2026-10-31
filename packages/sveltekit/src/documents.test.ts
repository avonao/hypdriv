import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyManifest } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { absolutizeAssetUrls, mergeMetaHashes, metaCspHashes, stageDocuments } from './documents';

const page = (prefix: string) => `<!doctype html>
<html><head>
<link href="${prefix}_app/immutable/entry/start.js" rel="modulepreload">
<link rel="stylesheet" href='${prefix}_app/immutable/assets/0.css'>
<link rel="icon" href="${prefix}favicon.svg">
<meta http-equiv="content-security-policy" content="object-src 'none'; script-src 'self' 'sha256-AAA='; style-src 'self' 'sha256-SSS='">
<!-- <script src="./ignored.js"></script> -->
</head><body>
<script>import("${prefix}_app/immutable/entry/start.js"); const s = '<link href="./not-a-tag.js">';</script>
<script type="module" src="${prefix}_app/immutable/entry/app.js"></script>
<a href="./sibling">link</a>
</body></html>`;

describe('absolutizeAssetUrls', () => {
  it('rewrites relative link/script URLs against the document URL and nothing else', () => {
    const out = absolutizeAssetUrls(page('./'), '/about');
    expect(out).toContain('<link href="/_app/immutable/entry/start.js" rel="modulepreload">');
    expect(out).toContain('<link rel="stylesheet" href=\'/_app/immutable/assets/0.css\'>');
    expect(out).toContain('<link rel="icon" href="/favicon.svg">');
    expect(out).toContain('<script type="module" src="/_app/immutable/entry/app.js"></script>');
    // Inline script contents, comments and anchors are untouched.
    expect(out).toContain(
      'import("./_app/immutable/entry/start.js"); const s = \'<link href="./not-a-tag.js">\';',
    );
    expect(out).toContain('<!-- <script src="./ignored.js"></script> -->');
    expect(out).toContain('<a href="./sibling">');
  });

  it('resolves parent-relative URLs of nested pages', () => {
    const out = absolutizeAssetUrls(page('../../'), '/blog/2026/post');
    expect(out).toContain('href="/_app/immutable/entry/start.js"');
    expect(absolutizeAssetUrls(page('../'), '/docs/').includes('href="/_app/immutable/entry/start.js"')).toBe(
      true,
    );
  });

  it('keeps root-relative and absolute URLs', () => {
    const html =
      '<link href="/_app/x.js" rel="modulepreload"><script src="https://cdn.example.com/a.js"></script>';
    expect(absolutizeAssetUrls(html, '/x')).toBe(html);
  });
});

describe('metaCspHashes / mergeMetaHashes', () => {
  it("reads the hashes of SvelteKit's meta policy", () => {
    expect(metaCspHashes(page('./'))).toEqual({
      scriptHashes: ["'sha256-AAA='"],
      styleHashes: ["'sha256-SSS='"],
    });
    expect(metaCspHashes('<meta name="description" content="x">')).toEqual({
      scriptHashes: [],
      styleHashes: [],
    });
    expect(
      metaCspHashes(
        `<meta content="script-src &#39;sha384-BBB=&#39;" http-equiv="Content-Security-Policy"><title>x</title>`,
      ),
    ).toEqual({ scriptHashes: ["'sha384-BBB='"], styleHashes: [] });
  });

  it('adds missing hashes to the CSP entries of static documents', () => {
    const manifest = emptyManifest();
    manifest.csp['page:/about'] = { scriptHashes: ["'sha256-AAA='"], styleHashes: [] };
    manifest.csp['page:/blog/[slug]#/blog/a'] = { scriptHashes: [], styleHashes: [] };
    manifest.csp['page:/blog/[slug]'] = { scriptHashes: [], styleHashes: [] };
    const changed = mergeMetaHashes(manifest, [
      { routeId: 'page:/about', pathname: '/about', html: page('./') },
      { routeId: 'page:/blog/[slug]', pathname: '/blog/a', html: page('../') },
      { routeId: 'page:/ssr', pathname: '/ssr', html: page('./') },
    ]);
    expect(changed).toBe(2);
    expect(manifest.csp['page:/about']).toEqual({
      scriptHashes: ["'sha256-AAA='"],
      styleHashes: ["'sha256-SSS='"],
    });
    expect(manifest.csp['page:/blog/[slug]#/blog/a']!.scriptHashes).toEqual(["'sha256-AAA='"]);
    expect(manifest.csp['page:/blog/[slug]']!.scriptHashes).toEqual([]);
    expect(manifest.csp['page:/ssr']).toBeUndefined();
  });
});

describe('stageDocuments', () => {
  it('copies prerendered pages with absolute asset URLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypdriv-sk-docs-'));
    const source = join(dir, 'pages');
    mkdirSync(join(source, 'blog'), { recursive: true });
    writeFileSync(join(source, 'index.html'), page('./'));
    writeFileSync(join(source, 'blog', 'a.html'), page('../'));
    const staged = stageDocuments(
      new Map([
        ['/', { file: 'index.html' }],
        ['/blog/a', { file: 'blog/a.html' }],
        ['/missing', { file: 'missing.html' }],
      ]),
      source,
      join(dir, 'staged'),
    );
    expect(staged.map((d) => d.pathname)).toEqual(['/', '/blog/a']);
    expect(readFileSync(staged[1]!.file, 'utf8')).toContain('href="/_app/immutable/entry/start.js"');
    // The originals stay as SvelteKit wrote them.
    expect(readFileSync(join(source, 'blog', 'a.html'), 'utf8')).toContain(
      'href="../_app/immutable/entry/start.js"',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
