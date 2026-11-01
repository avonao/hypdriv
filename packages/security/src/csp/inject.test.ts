import { describe, expect, it } from 'vitest';
import { decodeContentEncoding, injectNonceIntoHtml, injectNonceStream, NonceInjector } from './inject';

const N = 'abc123';

describe('portable nonce injection', () => {
  it('adds the nonce to scripts and script preloads that lack one', () => {
    const out = injectNonceIntoHtml(
      '<head><link rel="modulepreload" href="/a.js"><link rel=preload as=script href="/b.js"><script type="module" src="/c.js"></script></head>',
      N,
    );
    expect(out).toBe(
      `<head><link rel="modulepreload" href="/a.js" nonce="${N}"><link rel=preload as=script href="/b.js" nonce="${N}"><script type="module" src="/c.js" nonce="${N}"></script></head>`,
    );
  });

  it('keeps existing nonces and leaves stylesheets alone unless asked', () => {
    const html = '<script nonce="x">a()</script><style>p{}</style><link rel="stylesheet" href="/s.css">';
    expect(injectNonceIntoHtml(html, N)).toBe(html);
    expect(injectNonceIntoHtml(html, N, { styles: true })).toBe(
      `<script nonce="x">a()</script><style nonce="${N}">p{}</style><link rel="stylesheet" href="/s.css" nonce="${N}">`,
    );
  });

  it('never touches markup inside script, style, textarea, title or comments', () => {
    const html =
      '<script>const s = "<script>evil()</script" + ">";</script><textarea><script>x</script></textarea><title><script></title><!-- <script> --><style>a::after{content:"<script>"}</style>';
    const out = injectNonceIntoHtml(html, N);
    expect(out).toBe(
      `<script nonce="${N}">const s = "<script>evil()</script" + ">";</script><textarea><script>x</script></textarea><title><script></title><!-- <script> --><style>a::after{content:"<script>"}</style>`,
    );
  });

  it('respects quoted attribute values containing > and tag-like text', () => {
    const html = `<div data-x="<script>" title='a > b'><script data-y="1>2">go()</script></div>`;
    expect(injectNonceIntoHtml(html, N)).toBe(
      `<div data-x="<script>" title='a > b'><script data-y="1>2" nonce="${N}">go()</script></div>`,
    );
  });

  it('handles self-closing SVG scripts and unquoted values ending in a slash', () => {
    expect(injectNonceIntoHtml('<svg><script href="/x.js"/></svg><script>y()</script>', N)).toBe(
      `<svg><script href="/x.js" nonce="${N}"/></svg><script nonce="${N}">y()</script>`,
    );
    expect(injectNonceIntoHtml('<link rel=modulepreload href=/a/>', N)).toBe(
      `<link rel=modulepreload href=/a/ nonce="${N}">`,
    );
  });

  it('produces the same output for any chunking of the input', () => {
    const html =
      '<!doctype html><html><head><link rel="modulepreload" href="/a.js"><script>var t = "</scr" + "ipt>";</script></head><body><!-- c --><p>x &lt; y</p><script src="/z.js" async></script><SCRIPT>Up()</SCRIPT></body></html>';
    const expected = injectNonceIntoHtml(html, N);
    expect(expected).toContain(`<SCRIPT nonce="${N}">Up()</SCRIPT>`);
    for (let size = 1; size <= 9; size++) {
      const injector = new NonceInjector(N);
      let out = '';
      for (let i = 0; i < html.length; i += size) out += injector.push(html.slice(i, i + size));
      out += injector.flush();
      expect(out, `chunk size ${size}`).toBe(expected);
    }
  });

  it('streams a response body and drops content-length', async () => {
    const encoder = new TextEncoder();
    const parts = ['<html><head><scr', 'ipt>a()</sc', 'ript></head><body>ü</body></html>'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(encoder.encode(p));
        controller.close();
      },
    });
    const response = injectNonceStream(
      new Response(body, { headers: { 'content-type': 'text/html', 'content-length': '999' } }),
      N,
    );
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.text()).toBe(
      `<html><head><script nonce="${N}">a()</script></head><body>ü</body></html>`,
    );
  });

  it('escapes the nonce attribute value', () => {
    expect(injectNonceIntoHtml('<script></script>', 'a"b&c')).toBe(
      '<script nonce="a&quot;b&amp;c"></script>',
    );
  });
});

describe('decodeContentEncoding()', () => {
  const gzip = async (text: string) =>
    new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')), {
      headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': '999' },
    });

  it('returns unencoded responses as they are', () => {
    const response = new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } });
    expect(decodeContentEncoding(response)).toBe(response);
    const identity = new Response('x', { headers: { 'content-encoding': 'identity' } });
    expect(decodeContentEncoding(identity)).toBe(identity);
  });

  it('decompresses gzip and deflate and drops the encoding headers', async () => {
    const decoded = decodeContentEncoding(await gzip('<script>a()</script>'));
    expect(decoded).not.toBeNull();
    expect(decoded!.headers.get('content-encoding')).toBeNull();
    expect(decoded!.headers.get('content-length')).toBeNull();
    expect(decoded!.headers.get('content-type')).toBe('text/html');
    expect(await decoded!.text()).toBe('<script>a()</script>');
    const deflated = new Response(
      new Blob(['<b>z</b>']).stream().pipeThrough(new CompressionStream('deflate')),
      {
        headers: { 'content-encoding': 'deflate' },
      },
    );
    expect(await decodeContentEncoding(deflated)!.text()).toBe('<b>z</b>');
  });

  it('gives up on encodings the runtime cannot decode', () => {
    for (const encoding of ['br', 'zstd', 'gzip, br'])
      expect(
        decodeContentEncoding(new Response('x', { headers: { 'content-encoding': encoding } })),
      ).toBeNull();
  });

  it('lets the nonce reach compressed HTML through the portable injector', async () => {
    const decoded = decodeContentEncoding(await gzip('<html><script>x()</script></html>'))!;
    const body = await injectNonceStream(decoded, 'N0NCE').text();
    expect(body).toContain('<script nonce="N0NCE">x()</script>');
  });
});
