/**
 * Just enough ISO-BMFF to read an AVIF picture's size (the `ispe` property) before the WebAssembly decoder
 * allocates it.
 */

const u32 = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/** Boxes whose children are boxes; `meta` is a full box (four bytes of version and flags first). */
const CONTAINERS = new Set(['meta', 'iprp', 'ipco']);

/**
 * The largest `ispe` extent in the file (the primary image, or its grid, is never smaller than a thumbnail),
 * or `null` when there is none.
 */
export function probeAvif(b: Uint8Array): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  const walk = (start: number, end: number, depth: number): void => {
    let at = start;
    while (at + 8 <= end) {
      let size = u32(b, at);
      const type = fourcc(b, at + 4);
      let header = 8;
      if (size === 1 && at + 16 <= end) {
        size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12);
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header) return;
      const boxEnd = Math.min(end, at + size);
      const body = at + header;
      if (type === 'ispe' && body + 12 <= boxEnd) {
        const width = u32(b, body + 4);
        const height = u32(b, body + 8);
        if (!best || width * height > best.width * best.height) best = { width, height };
      } else if (CONTAINERS.has(type) && depth < 4) {
        walk(type === 'meta' ? body + 4 : body, boxEnd, depth + 1);
      }
      at = boxEnd;
    }
  };
  walk(0, b.length, 0);
  return best;
}
