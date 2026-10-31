import { loadConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import {
  adoptSvelteKitCsp,
  policyNonce,
  quoteSource,
  replaceInStream,
  svelteKitDirectives,
  withSvelteKitCsp,
} from './csp';

const encoder = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('quoteSource / svelteKitDirectives', () => {
  it('quotes keywords and crypto sources the way SvelteKit does', () => {
    expect(quoteSource('self')).toBe("'self'");
    expect(quoteSource('strict-dynamic')).toBe("'strict-dynamic'");
    expect(quoteSource('sha256-abc=')).toBe("'sha256-abc='");
    expect(quoteSource("'none'")).toBe("'none'");
    expect(quoteSource('https://cdn.example.com')).toBe('https://cdn.example.com');
    expect(quoteSource('data:')).toBe('data:');
  });

  it('drops undefined entries, per-response sources and report-to; keeps booleans', () => {
    expect(
      svelteKitDirectives({
        'script-src': ['self', 'https://js.example.com', 'nonce-abc', 'sha256-x='],
        'img-src': undefined,
        'object-src': ['none'],
        'report-to': ['endpoint'],
        'upgrade-insecure-requests': true,
        'block-all-mixed-content': false,
      }),
    ).toEqual({
      'script-src': ["'self'", 'https://js.example.com'],
      'object-src': ["'none'"],
      'upgrade-insecure-requests': true,
    });
    expect(svelteKitDirectives({ 'script-src': undefined })).toBeNull();
    expect(svelteKitDirectives(undefined)).toBeNull();
  });
});

describe('withSvelteKitCsp', () => {
  it('unions SvelteKit directives with HypDriv directives', () => {
    const config = withSvelteKitCsp(
      { security: { csp: { directives: { 'img-src': ['https://img.example.com'] } } } },
      { mode: 'auto', directives: { 'script-src': ['self', 'https://js.example.com'], 'img-src': ['self'] } },
    );
    const csp = config.security?.csp;
    expect(csp && typeof csp === 'object' ? csp.directives : null).toEqual({
      'script-src': ["'self'", 'https://js.example.com'],
      'img-src': ["'self'", 'https://img.example.com'],
    });
    // The merged config still resolves (and keeps HypDriv's strict defaults).
    const resolved = loadConfig(config);
    expect(resolved.security.csp?.directives['script-src']).toContain('https://js.example.com');
  });

  it('turns `csp: true` / an absent CSP config into an object with the directives', () => {
    const config = withSvelteKitCsp({ security: { csp: true } }, { directives: { 'frame-src': ['self'] } });
    expect(config.security?.csp).toEqual({ directives: { 'frame-src': ["'self'"] } });
    expect(withSvelteKitCsp({}, { directives: { 'frame-src': ['self'] } }).security?.csp).toEqual({
      directives: { 'frame-src': ["'self'"] },
    });
  });

  it('leaves the config untouched when HypDriv CSP is off or SvelteKit sets nothing', () => {
    const off = { security: { csp: false as const } };
    expect(withSvelteKitCsp(off, { directives: { 'script-src': ['self'] } })).toBe(off);
    const plain = { site: { name: 'x' } };
    expect(withSvelteKitCsp(plain, null)).toBe(plain);
    expect(withSvelteKitCsp(plain, { directives: {} })).toBe(plain);
  });
});

describe('replaceInStream', () => {
  it('replaces tokens inside and across chunks', async () => {
    const token = 'AbC+/d==';
    const chunks = [
      '<script nonce="AbC',
      '+/d==">x</script><style nonce="AbC+/d==">',
      '</style>Ab',
      'C+/d==',
    ];
    expect(await text(replaceInStream(streamOf(chunks), token, 'NEW'))).toBe(
      '<script nonce="NEW">x</script><style nonce="NEW"></style>NEW',
    );
  });

  it('handles one-byte chunks, partial matches and trailing prefixes', async () => {
    const input = 'xxaaabaaab-aaa';
    const chunks = input.split('');
    expect(await text(replaceInStream(streamOf(chunks), 'aab', 'Z'))).toBe(input.replaceAll('aab', 'Z'));
    expect(await text(replaceInStream(streamOf(['abcab']), 'abc', '!'))).toBe('!ab');
  });

  it('passes bodies without the token through unchanged', async () => {
    expect(await text(replaceInStream(streamOf(['hello ', 'world']), 'zzz', 'y'))).toBe('hello world');
  });
});

describe('policyNonce', () => {
  it('reads the nonce of a policy', () => {
    expect(policyNonce("script-src 'self' 'nonce-abc+/=='")).toBe('abc+/==');
    expect(policyNonce("script-src 'self'")).toBeNull();
    expect(policyNonce(null)).toBeNull();
  });
});

describe('adoptSvelteKitCsp', () => {
  const kitPolicy = "script-src 'self' 'nonce-SVELTEKIT1'; object-src 'none'";
  const html = (nonce: string) =>
    `<html><head><script nonce="${nonce}">a()</script></head><body><script nonce="${nonce}">b()</script></body></html>`;

  it("swaps SvelteKit's nonce for HypDriv's and removes SvelteKit's policy", async () => {
    const response = new Response(streamOf([html('SVELTEKIT1')]), {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-security-policy': kitPolicy,
        'content-security-policy-report-only': kitPolicy,
        etag: '"abc"',
        'content-length': '123',
        'x-other': '1',
      },
    });
    const out = adoptSvelteKitCsp(response, 'HYPDRIV');
    expect(out.headers.get('content-security-policy')).toBeNull();
    expect(out.headers.get('content-security-policy-report-only')).toBeNull();
    expect(out.headers.get('etag')).toBeNull();
    expect(out.headers.get('content-length')).toBeNull();
    expect(out.headers.get('x-other')).toBe('1');
    expect(await out.text()).toBe(html('HYPDRIV'));
  });

  it('removes a hash-mode SvelteKit policy without touching the body', async () => {
    const response = new Response(html('none'), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "script-src 'sha256-x='",
      },
    });
    const out = adoptSvelteKitCsp(response, 'HYPDRIV');
    expect(out.headers.has('content-security-policy')).toBe(false);
    expect(await out.text()).toBe(html('none'));
  });

  it("leaves SvelteKit's policy alone without a HypDriv nonce, for non-HTML and for HypDriv's own policy", () => {
    const page = () =>
      new Response('x', { headers: { 'content-type': 'text/html', 'content-security-policy': kitPolicy } });
    const a = page();
    expect(adoptSvelteKitCsp(a, null)).toBe(a);
    const json = new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-security-policy': kitPolicy },
    });
    expect(adoptSvelteKitCsp(json, 'N')).toBe(json);
    const own = new Response('x', {
      headers: { 'content-type': 'text/html', 'content-security-policy': kitPolicy, 'x-hypdriv-csp': 'hash' },
    });
    expect(adoptSvelteKitCsp(own, 'N')).toBe(own);
    const plain = new Response('x', { headers: { 'content-type': 'text/html' } });
    expect(adoptSvelteKitCsp(plain, 'N')).toBe(plain);
  });
});
