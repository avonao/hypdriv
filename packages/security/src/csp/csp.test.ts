import { type CspDirectives, HEADER, resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { makeCtx, route, runStage } from '../__tests__/helpers';
import { CSP_EXTRA_HASHES_KEY, CSP_MODE_KEY, NONCE_KEY } from '../keys';
import { buildCspDirectives, buildCspHeader, formatHashSource } from './build';
import { mergeDirectives, parseCsp, serializeCsp, withoutSource } from './directives';
import { type CspReport, cspReportHandler, suggestPolicy } from './report';
import { CSP_DECISION_KEY, cspStage, type HtmlRewriterConstructor, injectNonce } from './stage';

const baseCsp = resolveConfig({}).security.csp!;
const HASH = "'sha256-AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123='";

describe('directives', () => {
  it('serialises default-src first, then alphabetical, booleans bare', () => {
    const out = serializeCsp({
      'script-src': ["'self'", "'self'", 'https://x.test'],
      'upgrade-insecure-requests': true,
      'default-src': ["'self'"],
      'base-uri': ["'none'"],
      'block-all-mixed-content': false,
    });
    expect(out).toBe(
      "default-src 'self'; base-uri 'none'; script-src 'self' https://x.test; upgrade-insecure-requests",
    );
  });

  it('parses and round-trips', () => {
    const parsed = parseCsp(
      "default-src 'self'; script-src 'self' 'nonce-abc'; upgrade-insecure-requests; script-src 'none'",
    );
    expect(parsed).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'", "'nonce-abc'"],
      'upgrade-insecure-requests': true,
    });
    expect(parseCsp(serializeCsp(parsed))).toEqual(parsed);
    expect(parseCsp('')).toEqual({});
  });

  it('merges by union, drops none when sources are added, removes with false', () => {
    const merged = mergeDirectives(
      { 'img-src': ["'none'"], 'script-src': ["'self'"], 'frame-src': ["'self'"] },
      { 'img-src': ['https://cdn.test'], 'script-src': ['https://a.test', "'self'"] },
      { 'frame-src': false } as unknown as CspDirectives,
    );
    expect(merged).toEqual({ 'img-src': ['https://cdn.test'], 'script-src': ["'self'", 'https://a.test'] });
    expect(withoutSource({ 'style-src': ["'self'", "'unsafe-inline'"] }, "'unsafe-inline'")).toEqual({
      'style-src': ["'self'"],
    });
  });

  it('formats hash sources without double quoting', () => {
    expect(formatHashSource('sha256-abc')).toBe("'sha256-abc'");
    expect(formatHashSource("'sha256-abc'")).toBe("'sha256-abc'");
  });
});

describe('buildCspHeader', () => {
  it('nonce mode: self + nonce + strict-dynamic, report directives, upgrade in production', () => {
    const header = buildCspHeader({ config: baseCsp, mode: 'nonce', nonce: 'n0nce', development: false });
    const d = parseCsp(header);
    expect(d['script-src']).toEqual(["'self'", "'nonce-n0nce'", "'strict-dynamic'"]);
    expect(d['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d['report-uri']).toEqual(['/_hypdriv/csp-report']);
    expect(d['report-to']).toEqual(['hypdriv']);
    expect(d['upgrade-insecure-requests']).toBe(true);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(header.startsWith("default-src 'self'; ")).toBe(true);
  });

  it('hash mode: hashes + unsafe-inline fallback, no strict-dynamic, extra hashes accepted quoted or bare', () => {
    const header = buildCspHeader({
      config: baseCsp,
      mode: 'hash',
      hashes: { scriptHashes: [HASH], styleHashes: [] },
      extraScriptHashes: ['sha256-extra'],
      development: false,
    });
    const d = parseCsp(header);
    expect(d['script-src']).toEqual(["'self'", HASH, "'sha256-extra'", "'unsafe-inline'"]);
    expect(d['script-src']).not.toContain("'strict-dynamic'");
    expect(header).not.toContain("''sha256");
  });

  it('development adds unsafe-eval and the HMR websocket, never upgrade-insecure-requests', () => {
    const d = buildCspDirectives({
      config: baseCsp,
      mode: 'nonce',
      nonce: 'n',
      development: true,
      origin: 'http://localhost:3000',
    });
    expect(d['script-src']).toContain("'unsafe-eval'");
    expect(d['connect-src']).toEqual(["'self'", 'ws://localhost:3000']);
    expect(d['upgrade-insecure-requests']).toBeUndefined();
  });

  it('applies allow shorthands, style hashes when inline styles are off, trusted types and reportTo overrides', () => {
    const config = resolveConfig({
      security: {
        csp: {
          unsafeInlineStyles: false,
          trustedTypes: true,
          allow: {
            scripts: ['https://js.test'],
            images: ['https://img.test'],
            frameAncestors: ['https://parent.test'],
          },
        },
      },
    }).security.csp!;
    const d = buildCspDirectives({
      config,
      mode: 'hash',
      hashes: { scriptHashes: [], styleHashes: ["'sha256-style'"] },
      development: false,
      reportTo: null,
    });
    expect(d['script-src']).toEqual(["'self'", "'unsafe-inline'", 'https://js.test']);
    expect(d['style-src']).toEqual(["'self'", "'sha256-style'"]);
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https://img.test']);
    expect(d['frame-ancestors']).toEqual(["'self'", 'https://parent.test']);
    expect(d['require-trusted-types-for']).toEqual(["'script'"]);
    expect(d['trusted-types']).toEqual(['nextjs', 'react', 'hypdriv', "'allow-duplicates'"]);
    expect(d['report-uri']).toBeUndefined();
    const nonceStyles = buildCspDirectives({ config, mode: 'nonce', nonce: 'n', development: false });
    expect(nonceStyles['style-src']).toEqual(["'self'", "'nonce-n'"]);
  });

  it('unsafe-inline fallback mode has neither nonce nor strict-dynamic', () => {
    const d = buildCspDirectives({ config: baseCsp, mode: 'unsafe-inline', development: false });
    expect(d['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('requires a nonce in nonce mode', () => {
    expect(() => buildCspHeader({ config: baseCsp, mode: 'nonce', development: false })).toThrow();
  });
});

const staticRoute = route({ pathname: '/', classification: 'static' });
const dynamicRoute = route({ pathname: '/dash', classification: 'dynamic' });
const isrRoute = route({ pathname: '/blog', classification: 'isr' });
const manifest = { csp: { [staticRoute.id]: { scriptHashes: [HASH], styleHashes: [] } } };
const htmlNext = () =>
  new Response('<html><script>1</script></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

describe('cspStage mode selection', () => {
  it('static route with manifest hashes → hash mode as a response header only', async () => {
    const ctx = makeCtx({ route: staticRoute, manifest, url: 'https://app.test/' });
    const { response, forwarded } = await runStage(cspStage(ctx.config), ctx, htmlNext);
    expect(ctx.state.get(CSP_MODE_KEY)).toBe('hash');
    expect(ctx.state.get(NONCE_KEY)).toBeUndefined();
    expect(forwarded?.headers.get('content-security-policy')).toBeNull();
    const d = parseCsp(response.headers.get('content-security-policy'));
    expect(d['script-src']).toEqual(["'self'", HASH, "'unsafe-inline'"]);
    expect(response.headers.get(HEADER.cspMode)).toBe('hash');
    expect(response.headers.get('reporting-endpoints')).toBe(
      'hypdriv="https://app.test/_hypdriv/csp-report"',
    );
    expect(ctx.timings.list()).toContainEqual({ name: 'csp', desc: 'hash' });
  });

  it('dynamic route → nonce mode with request headers for Next.js', async () => {
    const ctx = makeCtx({ route: dynamicRoute, manifest, url: 'https://app.test/dash' });
    const { response, forwarded } = await runStage(cspStage(ctx.config), ctx, htmlNext);
    const nonce = ctx.state.get(NONCE_KEY)!;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(forwarded?.headers.get('x-nonce')).toBe(nonce);
    expect(parseCsp(forwarded?.headers.get('content-security-policy'))['script-src']).toContain(
      `'nonce-${nonce}'`,
    );
    const d = parseCsp(response.headers.get('content-security-policy'));
    expect(d['script-src']).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    expect(ctx.state.get(CSP_MODE_KEY)).toBe('nonce');
  });

  it('static route without hashes, RSC requests and unknown routes → nonce', async () => {
    const noHashes = makeCtx({ route: staticRoute });
    await runStage(cspStage(noHashes.config), noHashes, htmlNext);
    expect(noHashes.state.get(CSP_MODE_KEY)).toBe('nonce');

    const rsc = makeCtx({ route: staticRoute, manifest, headers: { rsc: '1' } });
    const { response } = await runStage(
      cspStage(rsc.config),
      rsc,
      () => new Response('0:[]', { headers: { 'content-type': 'text/x-component' } }),
    );
    expect(rsc.state.get(CSP_MODE_KEY)).toBe('nonce');
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('reporting-endpoints')).toContain('hypdriv=');

    const unknown = makeCtx({ url: 'https://app.test/anything' });
    await runStage(cspStage(unknown.config), unknown, htmlNext);
    expect(unknown.state.get(CSP_MODE_KEY)).toBe('nonce');
  });

  it('route overrides pick mode, report-only and merge directives', async () => {
    const config = resolveConfig({
      security: {
        csp: {
          routes: [
            {
              match: '/embed/**',
              mode: 'nonce',
              reportOnly: true,
              directives: { 'frame-ancestors': ['https://partner.test'] },
            },
          ],
        },
      },
    });
    const ctx = makeCtx({ config, route: staticRoute, manifest, url: 'https://app.test/embed/widget' });
    const { response } = await runStage(cspStage(config), ctx, htmlNext);
    expect(ctx.state.get(CSP_MODE_KEY)).toBe('report-only');
    expect(response.headers.get('content-security-policy')).toBeNull();
    const ro = parseCsp(response.headers.get('content-security-policy-report-only'));
    expect(ro['frame-ancestors']).toEqual(["'self'", 'https://partner.test']);
    expect(ro['script-src']?.[1]).toMatch(/^'nonce-/);
    expect(response.headers.get(HEADER.cspMode)).toBe('report-only');
  });

  it("reportOnly: 'both' emits an enforced policy and a stricter report-only copy", async () => {
    const config = resolveConfig({ security: { csp: { reportOnly: 'both' } } });
    const ctx = makeCtx({ config, route: staticRoute, manifest });
    const { response } = await runStage(cspStage(config), ctx, htmlNext);
    const enforced = parseCsp(response.headers.get('content-security-policy'));
    const ro = parseCsp(response.headers.get('content-security-policy-report-only'));
    expect(enforced['script-src']).toContain("'unsafe-inline'");
    expect(ro['script-src']).not.toContain("'unsafe-inline'");
    expect(ro['style-src']).toEqual(["'self'"]);
    expect(ctx.state.get(CSP_MODE_KEY)).toBe('hash');
  });

  it('keeps a policy the application already set', async () => {
    const ctx = makeCtx({ route: dynamicRoute });
    const { response } = await runStage(
      cspStage(ctx.config),
      ctx,
      () =>
        new Response('<html></html>', {
          headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'" },
        }),
    );
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(response.headers.get(HEADER.cspMode)).toBe('app');
  });

  it('mode off and disabled config', async () => {
    const off = resolveConfig({ security: { csp: { mode: 'off' } } });
    const ctx = makeCtx({ config: off, route: dynamicRoute });
    const { response, forwarded } = await runStage(cspStage(off), ctx, htmlNext);
    expect(ctx.state.get(CSP_MODE_KEY)).toBe('off');
    expect(forwarded?.headers.get('x-nonce')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get(HEADER.cspMode)).toBe('off');

    const disabled = resolveConfig({ security: { csp: false } });
    const ctx2 = makeCtx({ config: disabled, route: dynamicRoute });
    const r2 = await runStage(cspStage(disabled), ctx2, htmlNext);
    expect(ctx2.state.get(CSP_MODE_KEY)).toBe('off');
    expect(r2.response.headers.get(HEADER.cspMode)).toBeNull();
  });

  it('merges CSP_EXTRA_HASHES_KEY into script-src in hash and nonce mode', async () => {
    const ctx = makeCtx({ route: staticRoute, manifest });
    const stage = cspStage(ctx.config);
    await stage.pre!(ctx);
    ctx.state.set(CSP_EXTRA_HASHES_KEY, ["'sha256-speculation'"]);
    const response = await stage.post!(ctx, htmlNext());
    expect(parseCsp(response.headers.get('content-security-policy'))['script-src']).toContain(
      "'sha256-speculation'",
    );

    const nonceCtx = makeCtx({ route: dynamicRoute });
    await stage.pre!(nonceCtx);
    nonceCtx.state.set(CSP_EXTRA_HASHES_KEY, ["'sha256-speculation'"]);
    const r2 = await stage.post!(nonceCtx, htmlNext());
    const nonceScript = parseCsp(r2.headers.get('content-security-policy'))['script-src'];
    expect(nonceScript).toContain("'sha256-speculation'");
    expect(nonceScript).toContain("'strict-dynamic'");
  });

  it('post without a decision (short-circuit before csp.pre) leaves the response alone', async () => {
    const ctx = makeCtx({ route: dynamicRoute });
    const res = await cspStage(ctx.config).post!(ctx, htmlNext());
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('pre is order independent: the decision does not depend on cache or other stage state', async () => {
    const a = makeCtx({ route: isrRoute });
    const b = makeCtx({ route: isrRoute });
    b.state.set(CSP_EXTRA_HASHES_KEY, ['x']);
    const stage = cspStage(a.config, { htmlRewriter: FakeRewriter });
    await stage.pre!(a);
    await stage.pre!(b);
    expect(a.state.get(CSP_DECISION_KEY)?.mode).toBe(b.state.get(CSP_DECISION_KEY)?.mode);
    expect(a.state.get(CSP_DECISION_KEY)?.inject).toBe(true);
  });
});

/** Tiny HTMLRewriter stand-in: handles `<script ...>` and `<style ...>` start tags with a regex. */
class FakeElement {
  constructor(private attrs: Map<string, string>) {}
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  render(tag: string) {
    const attrs = [...this.attrs.entries()].map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<${tag}${attrs ? ` ${attrs}` : ''}>`;
  }
}
const FakeRewriter: HtmlRewriterConstructor = class {
  private handlers: Array<{ selector: string; element: (el: FakeElement) => void }> = [];
  on(selector: string, handlers: { element?(el: FakeElement): void | Promise<void> }) {
    if (handlers.element)
      this.handlers.push({ selector, element: handlers.element as (el: FakeElement) => void });
    return this;
  }
  transform(response: Response): Response {
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const tags = this.handlers.map((h) => h.selector.split('[')[0]!);
    (async () => {
      const html = await response.text();
      const out = html.replace(/<(script|style|link)\b([^>]*)>/g, (whole, tag: string, rawAttrs: string) => {
        const attrs = new Map<string, string>();
        for (const m of rawAttrs.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs.set(m[1]!, m[2] ?? '');
        const el = new FakeElement(attrs);
        let handled = false;
        this.handlers.forEach((h, i) => {
          if (tags[i] === tag) {
            handled = true;
            h.element(el);
          }
        });
        return handled ? el.render(tag) : whole;
      });
      const writer = stream.writable.getWriter();
      await writer.write(new TextEncoder().encode(out));
      await writer.close();
    })();
    return new Response(stream.readable, { status: response.status, headers: response.headers });
  }
};

describe('edge nonce injection', () => {
  const html =
    '<html><head><script src="/a.js"></script><script nonce="keep">x</script><style>b{}</style></head></html>';

  it('injectNonce adds the nonce to scripts lacking one and leaves existing ones', async () => {
    const out = injectNonce(new Response(html, { headers: { 'content-type': 'text/html' } }), 'N1', {
      htmlRewriter: FakeRewriter,
    });
    const text = await out.text();
    expect(text).toContain('<script src="/a.js" nonce="N1">');
    expect(text).toContain('<script nonce="keep">');
    expect(text).toContain('<style>');
    const withStyles = await injectNonce(new Response(html), 'N2', {
      htmlRewriter: FakeRewriter,
      styles: true,
    }).text();
    expect(withStyles).toContain('<style nonce="N2">');
    const untouched = injectNonce(new Response(html), 'N3', { htmlRewriter: null });
    expect(await untouched.text()).toBe(html);
  });

  it('isr route on the edge: nonce mode with injection; on Node: unsafe-inline fallback', async () => {
    const edge = makeCtx({ route: isrRoute });
    const edgeStage = cspStage(edge.config, { htmlRewriter: FakeRewriter });
    const r1 = await runStage(
      edgeStage,
      edge,
      () => new Response(html, { headers: { 'content-type': 'text/html' } }),
    );
    const nonce = edge.state.get(NONCE_KEY)!;
    expect(await r1.response.text()).toContain(`<script src="/a.js" nonce="${nonce}">`);
    expect(parseCsp(r1.response.headers.get('content-security-policy'))['script-src']).toContain(
      `'nonce-${nonce}'`,
    );
    expect(r1.response.headers.get(HEADER.cspMode)).toBe('nonce');

    const node = makeCtx({ route: isrRoute });
    const r2 = await runStage(cspStage(node.config, { htmlRewriter: null }), node, htmlNext);
    expect(node.state.get(CSP_MODE_KEY)).toBe('unsafe-inline-fallback');
    expect(node.state.get(NONCE_KEY)).toBeUndefined();
    const d = parseCsp(r2.response.headers.get('content-security-policy'));
    expect(d['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(r2.response.headers.get(HEADER.cspMode)).toBe('unsafe-inline-fallback');

    const never = makeCtx({ route: isrRoute });
    await runStage(
      cspStage(never.config, { htmlRewriter: FakeRewriter, edgeNonceInjection: 'never' }),
      never,
      htmlNext,
    );
    expect(never.state.get(CSP_MODE_KEY)).toBe('unsafe-inline-fallback');

    const always = makeCtx({ route: isrRoute });
    await runStage(
      cspStage(always.config, { htmlRewriter: null, edgeNonceInjection: 'always' }),
      always,
      htmlNext,
    );
    expect(always.state.get(CSP_MODE_KEY)).toBe('nonce');

    const dynamicNode = makeCtx({ route: dynamicRoute });
    await runStage(cspStage(dynamicNode.config, { htmlRewriter: null }), dynamicNode, htmlNext);
    expect(dynamicNode.state.get(CSP_MODE_KEY)).toBe('nonce');
  });

  it('uses globalThis.HTMLRewriter when present', async () => {
    (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = FakeRewriter;
    try {
      const ctx = makeCtx({ route: isrRoute });
      const { response } = await runStage(
        cspStage(ctx.config),
        ctx,
        () => new Response(html, { headers: { 'content-type': 'text/html' } }),
      );
      expect(await response.text()).toContain(`nonce="${ctx.state.get(NONCE_KEY)}"`);
    } finally {
      delete (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
    }
  });
});

describe('cspReportHandler and suggestPolicy', () => {
  const sink: CspReport[] = [];
  const handler = cspReportHandler({ sink: (r) => void sink.push(r), maxBytes: 2048 });

  it('accepts legacy, Reporting API and plain JSON bodies; rejects others', async () => {
    sink.length = 0;
    const legacy = await handler(
      new Request('https://app.test/_hypdriv/csp-report', {
        method: 'POST',
        headers: { 'content-type': 'application/csp-report', 'user-agent': 'UA/1' },
        body: JSON.stringify({
          'csp-report': {
            'document-uri': 'https://app.test/page',
            'violated-directive': 'script-src-elem',
            'effective-directive': 'script-src-elem',
            'blocked-uri': 'https://cdn.example.com/lib.js',
            'line-number': 12,
            disposition: 'enforce',
          },
        }),
      }),
    );
    expect(legacy.status).toBe(204);
    const api = await handler(
      new Request('https://app.test/_hypdriv/csp-report', {
        method: 'POST',
        headers: { 'content-type': 'application/reports+json' },
        body: JSON.stringify([
          {
            type: 'csp-violation',
            user_agent: 'UA/2',
            body: {
              documentURL: 'https://app.test/p',
              effectiveDirective: 'img-src',
              blockedURL: 'https://img.example.com/a.png',
              disposition: 'report',
            },
          },
          { type: 'deprecation', body: {} },
        ]),
      }),
    );
    expect(api.status).toBe(204);
    expect(sink).toHaveLength(2);
    expect(sink[0]).toMatchObject({
      effectiveDirective: 'script-src-elem',
      blockedUri: 'https://cdn.example.com/lib.js',
      lineNumber: 12,
      disposition: 'enforce',
      userAgent: 'UA/1',
    });
    expect(sink[1]).toMatchObject({
      effectiveDirective: 'img-src',
      disposition: 'report',
      userAgent: 'UA/2',
    });
    expect((await handler(new Request('https://app.test/x', { method: 'GET' }))).status).toBe(405);
    expect(
      (await handler(new Request('https://app.test/x', { method: 'POST', body: 'not json' }))).status,
    ).toBe(400);
    expect(
      (await handler(new Request('https://app.test/x', { method: 'POST', body: 'x'.repeat(5000) }))).status,
    ).toBe(413);
  });

  it('aggregates origins per directive, ignoring inline/eval/extensions', () => {
    const mk = (directive: string, blocked: string, doc = 'https://app.test/'): CspReport => ({
      documentUri: doc,
      violatedDirective: directive,
      effectiveDirective: directive,
      blockedUri: blocked,
      disposition: 'enforce',
      ts: 0,
    });
    const reports = [
      mk('script-src-elem', 'https://cdn.example.com/a.js'),
      mk('script-src-elem', 'https://cdn.example.com/b.js'),
      mk('script-src', 'inline'),
      mk('script-src', 'eval'),
      mk('script-src', 'chrome-extension://abc/inject.js'),
      mk('script-src', 'moz-extension://abc/inject.js'),
      mk('img-src', 'data'),
      mk('connect-src', 'https://api.example.com/v1/x'),
      mk('connect-src', 'https://api.example.com/v1/y'),
      mk('connect-src', 'https://api.example.com/v1/z'),
      mk('frame-src', 'about:blank'),
      mk('font-src', 'https://app.test/fonts/x.woff2'),
    ];
    const current = { 'script-src': ["'self'"], 'connect-src': ["'self'"], 'img-src': ["'self'"] };
    const { additions, directives } = suggestPolicy(reports, current);
    expect(additions).toEqual([
      { directive: 'connect-src', source: 'https://api.example.com', count: 3 },
      { directive: 'script-src', source: 'https://cdn.example.com', count: 2 },
      { directive: 'font-src', source: "'self'", count: 1 },
      { directive: 'img-src', source: 'data:', count: 1 },
    ]);
    expect(directives['script-src']).toEqual(["'self'", 'https://cdn.example.com']);
    expect(directives['connect-src']).toEqual(["'self'", 'https://api.example.com']);
  });
});
