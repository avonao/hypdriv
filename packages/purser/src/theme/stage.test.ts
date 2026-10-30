import {
  createContext,
  HEADER,
  type HypDrivConfig,
  type PurserConfig,
  resolveConfig,
  runPipeline,
} from '@hypdriv/core';
import { afterEach, describe, expect, it } from 'vitest';
import { THEME_KEY } from './resolve';
import { type HtmlRewriterElement, mergeThemeClasses, THEME_RESOLVED_KEY, themeStage } from './stage';

const themed: HypDrivConfig = {
  purser: {
    theme: {
      axes: {
        mode: {
          classes: { light: null, dark: 'dark' },
          default: 'light',
          clientHint: { hint: 'prefers-color-scheme', values: { dark: 'dark', light: 'light' } },
        },
        motion: {
          classes: { full: null, reduced: 'reduce-motion' },
          default: 'full',
          clientHint: { hint: 'prefers-reduced-motion', values: { reduce: 'reduced' } },
        },
      },
    },
  },
};

/** A minimal HTMLRewriter stand-in: rewrites the `<html>` start tag through the registered handler. */
class FakeHTMLRewriter {
  private readonly handlers: Array<{
    selector: string;
    element(el: HtmlRewriterElement): void | Promise<void>;
  }> = [];
  on(selector: string, handlers: { element(el: HtmlRewriterElement): void | Promise<void> }) {
    this.handlers.push({ selector, element: handlers.element });
    return this;
  }
  transform(response: Response): Response {
    const handlers = this.handlers;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const text = await response.text();
        const out = text.replace(/<html\b([^>]*)>/i, (_m, attrText: string) => {
          const attrs = new Map<string, string>();
          for (const m of attrText.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs.set(m[1]!, m[2] ?? '');
          const el: HtmlRewriterElement = {
            getAttribute: (n) => attrs.get(n) ?? null,
            setAttribute: (n, v) => attrs.set(n, v),
            removeAttribute: (n) => attrs.delete(n),
          };
          for (const h of handlers) if (h.selector === 'html') h.element(el);
          const serialized = [...attrs].map(([k, v]) => ` ${k}="${v}"`).join('');
          return `<html${serialized}>`;
        });
        controller.enqueue(new TextEncoder().encode(out));
        controller.close();
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    ...init,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) },
  });

async function run(
  config: HypDrivConfig,
  request: Request,
  upstream: (req: Request) => Response,
  runner: 'worker' | 'proxy' = 'worker',
) {
  const resolved = resolveConfig(config);
  const ctx = createContext({ request, config: resolved, runner });
  let forwarded: Request | undefined;
  const { response } = await runPipeline({
    stages: [themeStage(resolved)],
    ctx,
    next: async (req) => {
      forwarded = req;
      return upstream(req);
    },
  });
  return { ctx, response, forwarded: forwarded! };
}

afterEach(() => {
  delete (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
});

describe('themeStage', () => {
  it('pins classes on <html> through HTMLRewriter and negotiates client hints', async () => {
    (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = FakeHTMLRewriter;
    const { ctx, response, forwarded } = await run(
      themed,
      new Request('https://x.test/', {
        headers: { cookie: 'hyp_theme=mode%3Ddark', 'sec-ch-prefers-reduced-motion': 'reduce' },
      }),
      () => html('<!doctype html><html lang="en" class="__font"><body>hi</body></html>'),
    );
    expect(await response.text()).toBe(
      '<!doctype html><html lang="en" class="__font dark reduce-motion" data-hypdriv-theme="mode=dark;motion=reduced"><body>hi</body></html>',
    );
    expect(forwarded.headers.get(HEADER.theme)).toBe('mode=dark;motion=reduced');
    expect(ctx.state.get(THEME_KEY)).toEqual({ mode: 'dark', motion: 'reduced' });
    expect(ctx.state.get(THEME_RESOLVED_KEY)?.sources).toEqual({ mode: 'cookie', motion: 'hint' });
    expect(response.headers.get('accept-ch')).toBe(
      'Sec-CH-Prefers-Color-Scheme, Sec-CH-Prefers-Reduced-Motion',
    );
    expect(response.headers.get('critical-ch')).toBe('Sec-CH-Prefers-Color-Scheme');
    expect(response.headers.get('vary')).toBe(
      'Cookie, Sec-CH-Prefers-Color-Scheme, Sec-CH-Prefers-Reduced-Motion',
    );
  });

  it('removes stale theme classes and merges with existing Vary', async () => {
    (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = FakeHTMLRewriter;
    const { response } = await run(themed, new Request('https://x.test/'), () =>
      html('<html class="dark reduce-motion app"><body></body></html>', {
        headers: { vary: 'Accept-Encoding' },
      }),
    );
    expect(await response.text()).toBe(
      '<html class="app" data-hypdriv-theme="mode=light;motion=full"><body></body></html>',
    );
    expect(response.headers.get('vary')).toBe(
      'Accept-Encoding, Cookie, Sec-CH-Prefers-Color-Scheme, Sec-CH-Prefers-Reduced-Motion',
    );
  });

  it('is header-only without HTMLRewriter (proxy / next start)', async () => {
    const body = '<html><body></body></html>';
    const { response, forwarded } = await run(
      themed,
      new Request('https://x.test/', { headers: { 'sec-ch-prefers-color-scheme': 'dark' } }),
      () => html(body),
    );
    expect(await response.text()).toBe(body);
    expect(forwarded.headers.get(HEADER.theme)).toBe('mode=dark;motion=full');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(response.headers.get('accept-ch')).toContain('Sec-CH-Prefers-Color-Scheme');
  });

  it('leaves non-HTML responses and RSC requests alone', async () => {
    (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = FakeHTMLRewriter;
    const json = await run(
      themed,
      new Request('https://x.test/api'),
      () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    );
    expect(json.response.headers.get('vary')).toBeNull();
    expect(json.response.headers.get('accept-ch')).toBeNull();
    expect(json.forwarded.headers.get(HEADER.theme)).toBe('mode=light;motion=full');

    const rsc = await run(themed, new Request('https://x.test/', { headers: { rsc: '1' } }), () =>
      html('<html><body></body></html>'),
    );
    expect(rsc.forwarded.headers.get(HEADER.theme)).toBeNull();
    expect(rsc.ctx.state.get(THEME_KEY)).toBeUndefined();
    expect(rsc.response.headers.get('vary')).toBeNull();
  });

  it('skips Accept-CH when client hints are disabled and is a no-op without a theme', async () => {
    const noHints: HypDrivConfig = {
      purser: { theme: { ...(themed.purser as PurserConfig).theme!, acceptClientHints: false } },
    };
    const { response } = await run(noHints, new Request('https://x.test/'), () => html('<html></html>'));
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(response.headers.get('accept-ch')).toBeNull();

    const plain = await run({}, new Request('https://x.test/'), () => html('<html></html>'));
    expect(plain.response.headers.get('vary')).toBeNull();
    expect(plain.forwarded.headers.get(HEADER.theme)).toBeNull();
    expect(plain.ctx.state.get(THEME_KEY)).toBeUndefined();
  });
});

describe('mergeThemeClasses', () => {
  const known = new Set(['dark', 'hc']);
  it('keeps unknown classes, drops unselected theme classes, appends selected ones once', () => {
    expect(mergeThemeClasses('a  dark b', ['hc'], known)).toBe('a b hc');
    expect(mergeThemeClasses(null, ['dark', 'dark'], known)).toBe('dark');
    expect(mergeThemeClasses('dark', [], known)).toBe('');
    expect(mergeThemeClasses('x x', [], known)).toBe('x');
  });
});

describe('themeStage in proxy.ts', () => {
  it('negotiates on Next.js pass-through responses (no body to rewrite yet)', async () => {
    const { response, forwarded } = await run(
      themed,
      new Request('https://x.test/docs', {
        headers: { cookie: 'hyp_theme=mode%3Ddark', accept: 'text/html' },
      }),
      () => new Response(null, { headers: { 'x-middleware-next': '1' } }),
      'proxy',
    );
    expect(forwarded.headers.get(HEADER.theme)).toContain('mode=dark');
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(response.headers.get('accept-ch')).toContain('Sec-CH-Prefers-Color-Scheme');
  });
});
