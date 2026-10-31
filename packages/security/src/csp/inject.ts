/**
 * Portable streaming nonce injection: adds `nonce="…"` to `<script>` (and optionally `<style>` /
 * `<link rel="stylesheet">`) start tags of an HTML response that lack one, plus `<link rel="modulepreload">`
 * and `<link rel="preload" as="script">`, whose fetches CSP also checks against the element's nonce.
 *
 * It is the runtime-neutral counterpart of the `HTMLRewriter` transform the `csp` stage uses on Workers, for
 * runners that own the response body outside workerd (framework hooks on Node and Vercel Functions). The
 * tokenizer follows the HTML parsing states that matter for finding real start tags: quoted attribute values,
 * comments, `<!…>` declarations, and raw-text / RCDATA elements (`script`, `style`, `textarea`, `title`,
 * `xmp`, `iframe`, `noembed`, `noframes`, `plaintext`) whose content is never parsed as markup. Text is
 * streamed through as soon as it cannot belong to an unfinished tag, so large documents are not buffered.
 */

export interface NonceInjectionOptions {
  /** Also nonce `<style>` and `<link rel="stylesheet">` (when inline styles are not allowed otherwise). */
  styles?: boolean;
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

type State = { kind: 'data' } | { kind: 'raw'; tag: string } | { kind: 'plaintext' };

interface ParsedTag {
  name: string;
  /** Index of the `>` that closes the tag. */
  end: number;
  /** `/>` (a self-closing flag; raw-text elements written this way only occur in SVG/MathML). */
  selfClosing: boolean;
  attrs: Map<string, string | null>;
}

const NAME_START = /[A-Za-z]/;
const SPACE = /[\t\n\f\r ]/;

/**
 * Parses the start tag that begins at `start` (`<` followed by a letter), following the HTML tokenizer's
 * attribute states (quoted values may contain `>`; an unquoted value ends at whitespace or `>`). Returns
 * `null` when the tag is not complete in `text` yet.
 */
function parseStartTag(text: string, start: number): ParsedTag | null {
  let i = start + 1;
  while (i < text.length && !SPACE.test(text[i]!) && text[i] !== '>' && text[i] !== '/') i++;
  if (i >= text.length) return null;
  const name = text.slice(start + 1, i).toLowerCase();
  const attrs = new Map<string, string | null>();
  while (i < text.length) {
    const ch = text[i]!;
    if (SPACE.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/') {
      if (i + 1 >= text.length) return null;
      if (text[i + 1] === '>') return { name, end: i + 1, selfClosing: true, attrs };
      i++;
      continue;
    }
    if (ch === '>') return { name, end: i, selfClosing: false, attrs };
    // attribute name
    const nameStart = i;
    i++;
    while (i < text.length && !SPACE.test(text[i]!) && text[i] !== '>' && text[i] !== '=' && text[i] !== '/')
      i++;
    if (i >= text.length) return null;
    const attrName = text.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < text.length && SPACE.test(text[j]!)) j++;
    if (j >= text.length) return null;
    if (text[j] !== '=') {
      if (!attrs.has(attrName)) attrs.set(attrName, null);
      continue;
    }
    i = j + 1;
    while (i < text.length && SPACE.test(text[i]!)) i++;
    if (i >= text.length) return null;
    const quote = text[i];
    let value: string;
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, i + 1);
      if (close < 0) return null;
      value = text.slice(i + 1, close);
      i = close + 1;
    } else {
      const valueStart = i;
      while (i < text.length && !SPACE.test(text[i]!) && text[i] !== '>') i++;
      if (i >= text.length) return null;
      value = text.slice(valueStart, i);
    }
    // Duplicate attributes are ignored by the parser: the first one wins.
    if (!attrs.has(attrName)) attrs.set(attrName, value);
  }
  return null;
}

function relTokens(value: string | null | undefined): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .filter(Boolean);
}

function wantsNonce(tag: ParsedTag, styles: boolean): boolean {
  if (tag.attrs.has('nonce')) return false;
  if (tag.name === 'script') return true;
  if (tag.name === 'style') return styles;
  if (tag.name === 'link') {
    const rel = relTokens(tag.attrs.get('rel'));
    if (rel.includes('modulepreload')) return true;
    if (rel.includes('preload') && (tag.attrs.get('as') ?? '').toLowerCase() === 'script') return true;
    if (styles && rel.includes('stylesheet')) return true;
  }
  return false;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Finds `</name` followed by a tag-name terminator, case-insensitively. Returns -1 when absent. */
function findEndTag(text: string, from: number, name: string): number {
  const needle = `</${name}`;
  let at = from;
  for (;;) {
    const idx = text.toLowerCase().indexOf(needle, at);
    if (idx < 0) return -1;
    const after = text[idx + needle.length];
    if (after === undefined) return -2; // cannot tell yet
    if (after === '>' || after === '/' || SPACE.test(after)) return idx;
    at = idx + 1;
  }
}

/**
 * Incremental injector over decoded text. `push` returns the text that is safe to emit; `flush` returns the
 * rest at the end of the stream.
 */
export class NonceInjector {
  private buffer = '';
  private state: State = { kind: 'data' };
  private readonly attribute: string;
  private readonly styles: boolean;

  constructor(nonce: string, options: NonceInjectionOptions = {}) {
    this.attribute = ` nonce="${escapeAttribute(nonce)}"`;
    this.styles = options.styles === true;
  }

  push(chunk: string): string {
    this.buffer += chunk;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let out = '';
    let text = this.buffer;
    let i = 0;
    for (;;) {
      if (this.state.kind === 'plaintext') {
        out += text.slice(i);
        i = text.length;
        break;
      }
      if (this.state.kind === 'raw') {
        const tag = this.state.tag;
        const end = findEndTag(text, i, tag);
        if (end === -1 || end === -2) {
          // Keep enough of the tail to recognise an end tag split across chunks.
          const keep = final ? 0 : Math.min(text.length - i, tag.length + 2);
          out += text.slice(i, text.length - keep);
          i = text.length - keep;
          break;
        }
        out += text.slice(i, end);
        i = end;
        this.state = { kind: 'data' };
        continue;
      }
      const lt = text.indexOf('<', i);
      if (lt < 0) {
        out += text.slice(i);
        i = text.length;
        break;
      }
      out += text.slice(i, lt);
      i = lt;
      const next = text[lt + 1];
      if (next === undefined) break; // need more input
      if (next === '!') {
        if (text.startsWith('<!--', lt)) {
          const close = text.indexOf('-->', lt + 4);
          if (close < 0) break;
          out += text.slice(lt, close + 3);
          i = close + 3;
          continue;
        }
        if (text.length - lt < 4 && '<!--'.startsWith(text.slice(lt))) break;
        const close = text.indexOf('>', lt + 2);
        if (close < 0) break;
        out += text.slice(lt, close + 1);
        i = close + 1;
        continue;
      }
      if (next === '?') {
        const close = text.indexOf('>', lt + 2);
        if (close < 0) break;
        out += text.slice(lt, close + 1);
        i = close + 1;
        continue;
      }
      if (next === '/') {
        const close = text.indexOf('>', lt + 2);
        if (close < 0) break;
        out += text.slice(lt, close + 1);
        i = close + 1;
        continue;
      }
      if (!NAME_START.test(next)) {
        out += '<';
        i = lt + 1;
        continue;
      }
      const tag = parseStartTag(text, lt);
      if (!tag) break;
      const raw = text.slice(lt, tag.end + 1);
      if (wantsNonce(tag, this.styles)) {
        // Insert right before `/>` or `>`.
        const closeAt = raw.length - (tag.selfClosing ? 2 : 1);
        out += `${raw.slice(0, closeAt)}${this.attribute}${raw.slice(closeAt)}`;
      } else {
        out += raw;
      }
      i = tag.end + 1;
      if (tag.name === 'plaintext' && !tag.selfClosing) this.state = { kind: 'plaintext' };
      else if (RAW_TEXT.has(tag.name) && !tag.selfClosing) this.state = { kind: 'raw', tag: tag.name };
    }
    text = text.slice(i);
    if (final) {
      out += text;
      text = '';
    }
    this.buffer = text;
    return out;
  }
}

/** Injects `nonce` into every eligible tag of an HTML string (see `NonceInjector`). */
export function injectNonceIntoHtml(
  html: string,
  nonce: string,
  options: NonceInjectionOptions = {},
): string {
  const injector = new NonceInjector(nonce, options);
  return injector.push(html) + injector.flush();
}

/**
 * Returns a response whose HTML body carries the nonce, streaming (no full buffering). Responses without a
 * body are returned unchanged. The body must be UTF-8 (HTML documents served by frameworks are).
 */
export function injectNonceStream(
  response: Response,
  nonce: string,
  options: NonceInjectionOptions = {},
): Response {
  if (!response.body) return response;
  const injector = new NonceInjector(nonce, options);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = injector.push(decoder.decode(chunk, { stream: true }));
      if (text) controller.enqueue(encoder.encode(text));
    },
    flush(controller) {
      const text = injector.push(decoder.decode()) + injector.flush();
      if (text) controller.enqueue(encoder.encode(text));
    },
  });
  const headers = new Headers(response.headers);
  // The body changes length; let the runtime frame it.
  headers.delete('content-length');
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
