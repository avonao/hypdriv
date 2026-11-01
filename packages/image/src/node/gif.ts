import { assertDimensions, DEFAULT_MAX_PIXELS, type RowSink } from './raster';

export interface GifInfo {
  width: number;
  height: number;
}

export function isGif(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  );
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);

/**
 * Reads the logical screen size. A screen of 0×0 (some writers do that) is the extent of the first frame
 * instead, as in browsers.
 */
export function probeGif(bytes: Uint8Array): GifInfo {
  if (!isGif(bytes)) throw new Error('not a GIF file');
  const width = u16(bytes, 6);
  const height = u16(bytes, 8);
  if (width > 0 && height > 0) return { width, height };
  const flags = bytes[10]!;
  let at = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  while (at < bytes.length) {
    const block = bytes[at++]!;
    if (block === 0x21) {
      at = skipSubBlocks(bytes, at + 1);
    } else if (block === 0x2c) {
      if (at + 8 > bytes.length) break;
      return { width: u16(bytes, at) + u16(bytes, at + 4), height: u16(bytes, at + 2) + u16(bytes, at + 6) };
    } else {
      break;
    }
  }
  return { width, height };
}

/** Variable-width LZW decoding of one GIF image into palette indices. */
function lzwDecode(
  minCodeSize: number,
  data: Uint8Array,
  pixelCount: number,
): { indices: Uint8Array; produced: number } {
  if (!(minCodeSize >= 2 && minCodeSize <= 8)) throw new Error(`invalid GIF LZW code size ${minCodeSize}`);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  const stack = new Uint8Array(4097);
  const out = new Uint8Array(pixelCount);

  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let prev = -1;
  let first = 0;
  let produced = 0;
  let bits = 0;
  let have = 0;
  let at = 0;

  while (produced < pixelCount) {
    while (have < codeSize) {
      if (at >= data.length) return { indices: out, produced }; // ran out of data: the rest stays index 0
      bits |= data[at++]! << have;
      have += 8;
    }
    const code = bits & ((1 << codeSize) - 1);
    bits >>>= codeSize;
    have -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = end + 1;
      prev = -1;
      continue;
    }
    if (code === end) break;
    if (prev === -1) {
      if (code >= clear) throw new Error('corrupt GIF image data');
      out[produced++] = suffix[code]!;
      prev = code;
      first = code;
      continue;
    }
    let current = code;
    let sp = 0;
    if (code >= next) {
      if (code > next) throw new Error('corrupt GIF image data');
      stack[sp++] = first;
      current = prev;
    }
    while (current >= clear) {
      stack[sp++] = suffix[current]!;
      current = prefix[current]!;
    }
    first = suffix[current]!;
    stack[sp++] = first;
    while (sp > 0 && produced < pixelCount) out[produced++] = stack[--sp]!;
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return { indices: out, produced };
}

function skipSubBlocks(bytes: Uint8Array, at: number): number {
  let pos = at;
  while (pos < bytes.length) {
    const size = bytes[pos++]!;
    if (size === 0) break;
    pos += size;
  }
  return pos;
}

function readSubBlocks(bytes: Uint8Array, at: number): { data: Uint8Array; next: number } {
  const parts: Uint8Array[] = [];
  let pos = at;
  let total = 0;
  while (pos < bytes.length) {
    const size = bytes[pos++]!;
    if (size === 0) break;
    const part = bytes.subarray(pos, Math.min(bytes.length, pos + size));
    parts.push(part);
    total += part.length;
    pos += size;
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return { data, next: pos };
}

/**
 * Decodes the first frame of a GIF (interlaced or not, with transparency) onto the logical screen and
 * streams the rows into `sink`. Pixels outside the frame stay transparent.
 */
export function decodeGif(bytes: Uint8Array, sink: RowSink, options: { maxPixels?: number } = {}): GifInfo {
  const info = probeGif(bytes);
  const { width, height } = info;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  assertDimensions(width, height, maxPixels);

  const screenFlags = bytes[10]!;
  let at = 13;
  let globalPalette: Uint8Array | null = null;
  if (screenFlags & 0x80) {
    const length = 3 * (1 << ((screenFlags & 7) + 1));
    globalPalette = bytes.subarray(at, at + length);
    at += length;
  }

  let transparent = -1;
  while (at < bytes.length) {
    const block = bytes[at++]!;
    if (block === 0x21) {
      const label = bytes[at++]!;
      if (label === 0xf9 && bytes[at] === 4) {
        const flags = bytes[at + 1]!;
        transparent = flags & 1 ? bytes[at + 4]! : -1;
      }
      at = skipSubBlocks(bytes, at);
    } else if (block === 0x2c) {
      const left = u16(bytes, at);
      const top = u16(bytes, at + 2);
      const frameWidth = u16(bytes, at + 4);
      const frameHeight = u16(bytes, at + 6);
      const flags = bytes[at + 8]!;
      at += 9;
      let palette = globalPalette;
      if (flags & 0x80) {
        const length = 3 * (1 << ((flags & 7) + 1));
        palette = bytes.subarray(at, at + length);
        at += length;
      }
      if (!palette) throw new Error('GIF frame has no color table');
      assertDimensions(frameWidth, frameHeight, maxPixels);
      if (at >= bytes.length) throw new Error('GIF image data is truncated');
      const minCodeSize = bytes[at++]!;
      const { data } = readSubBlocks(bytes, at);
      const { indices, produced } = lzwDecode(minCodeSize, data, frameWidth * frameHeight);
      if (produced === 0) throw new Error('GIF image data is empty or truncated');

      const interlaced = (flags & 0x40) !== 0;
      // output row (in frame coordinates) of every decoded row
      const order = new Int32Array(frameHeight);
      if (interlaced) {
        let i = 0;
        for (const [start, step] of [
          [0, 8],
          [4, 8],
          [2, 4],
          [1, 2],
        ] as const) {
          for (let y = start; y < frameHeight; y += step) order[y] = i++;
        }
      } else {
        for (let y = 0; y < frameHeight; y++) order[y] = y;
      }

      sink.begin(width, height);
      const blank = new Uint8Array(width * 4);
      const row = new Uint8Array(width * 4);
      for (let y = 0; y < height; y++) {
        const fy = y - top;
        if (fy < 0 || fy >= frameHeight) {
          sink.push(y, blank);
          continue;
        }
        row.fill(0);
        const source = order[fy]! * frameWidth;
        for (let x = 0; x < frameWidth; x++) {
          const px = left + x;
          if (px >= width) break;
          const index = indices[source + x]!;
          if (index === transparent) continue;
          const p = index * 3;
          row[px * 4] = palette[p] ?? 0;
          row[px * 4 + 1] = palette[p + 1] ?? 0;
          row[px * 4 + 2] = palette[p + 2] ?? 0;
          row[px * 4 + 3] = 255;
        }
        sink.push(y, row);
      }
      return info;
    } else if (block === 0x3b) {
      break;
    } else {
      throw new Error('corrupt GIF block structure');
    }
  }
  throw new Error('GIF has no image data');
}
