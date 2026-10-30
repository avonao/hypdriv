import { defineStage, isHtmlLike, type ResolvedConfig, type Stage } from '@hypdriv/core';

type Rewriter = {
  on(selector: string, handlers: Record<string, (node: never) => void>): Rewriter;
  onDocument(handlers: Record<string, (node: never) => void>): Rewriter;
  transform(response: Response): Response;
};

function rewriter(): Rewriter | null {
  const R = (globalThis as { HTMLRewriter?: new () => Rewriter }).HTMLRewriter;
  return R ? new R() : null;
}

/**
 * Streaming HTML transforms (all off by default): strip comments and collapse whitespace between tags.
 * React hydration relies on `<!--$-->` boundary comments, so those are always preserved.
 */
export function htmlTransformsStage(config: ResolvedConfig): Stage | null {
  const { stripComments, collapseWhitespace } = config.performance.html;
  if (!stripComments && !collapseWhitespace) return null;
  return defineStage({
    name: 'html-transforms',
    edgeOnly: true,
    runOnRsc: false,
    post(ctx, response) {
      if (!isHtmlLike(ctx, response) || response.status !== 200) return response;
      const r = rewriter();
      if (!r) return response;
      if (stripComments) {
        r.onDocument({
          comments(comment: { text: string; remove(): void }) {
            const t = comment.text.trim();
            if (
              t === '$' ||
              t === '/$' ||
              t.startsWith('$?') ||
              t.startsWith('$!') ||
              t.startsWith('$~') ||
              t.startsWith('&')
            )
              return;
            comment.remove();
          },
        } as never);
      }
      if (collapseWhitespace) {
        // Whitespace is significant inside these elements; track nesting so their text is left untouched.
        let preserve = 0;
        r.on('pre, textarea, script, style, code', {
          element(el: { onEndTag?(handler: () => void): void; removed?: boolean }) {
            preserve++;
            if (typeof el.onEndTag === 'function') el.onEndTag(() => void preserve--);
            else preserve--;
          },
        } as never);
        r.onDocument({
          text(text: {
            text: string;
            lastInTextNode: boolean;
            replace(content: string, options?: { html?: boolean }): void;
          }) {
            if (preserve > 0) return;
            if (/^\s{2,}$/.test(text.text)) text.replace(' ');
          },
        } as never);
      }
      ctx.timings.mark('html', 'transformed');
      return r.transform(response);
    },
  });
}

/** Adds `fetchpriority="high"` to the first image matching the configured selectors (likely LCP). */
export function priorityHintsStage(config: ResolvedConfig): Stage | null {
  const ph = config.performance.priorityHints;
  if (!ph?.selectors.length) return null;
  return defineStage({
    name: 'priority-hints',
    edgeOnly: true,
    runOnRsc: false,
    post(ctx, response) {
      if (!isHtmlLike(ctx, response) || response.status !== 200) return response;
      const r = rewriter();
      if (!r) return response;
      let done = false;
      for (const selector of ph.selectors) {
        r.on(selector, {
          element(el: {
            getAttribute(n: string): string | null;
            setAttribute(n: string, v: string): void;
            removeAttribute(n: string): void;
          }) {
            if (done) return;
            done = true;
            el.setAttribute('fetchpriority', 'high');
            if (el.getAttribute('loading') === 'lazy') el.removeAttribute('loading');
          },
        } as never);
      }
      return r.transform(response);
    },
  });
}

/** Edge-only stages appended to the defaults by the Worker shell. */
export function edgeStages(config: ResolvedConfig): Stage[] {
  return [htmlTransformsStage(config), priorityHintsStage(config)].filter((s): s is Stage => s !== null);
}
