import { constants, createInflate, deflateSync } from 'node:zlib';
import { assertDimensions, DEFAULT_MAX_PIXELS, type RowSink } from './raster';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  /** 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA. */
  colorType: number;
  interlaced: boolean;
}

interface PngChunks {
  info: PngInfo;
  palette: Uint8Array | null;
  transparency: Uint8Array | null;
  idat: Uint8Array[];
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const VALID_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

function readChunks(bytes: Uint8Array, headerOnly: boolean): PngChunks {
  if (!isPng(bytes)) throw new Error('not a PNG file');
  let info: PngInfo | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const start = at + 8;
    const end = start + length;
    if (end > bytes.length) {
      if (type === 'IDAT' && !headerOnly) {
        idat.push(bytes.subarray(start)); // truncated file: decode what is there
      }
      break;
    }
    const data = bytes.subarray(start, end);
    if (type === 'IHDR') {
      if (length < 13) throw new Error('corrupt PNG header');
      const colorType = data[9]!;
      const bitDepth = data[8]!;
      if (!(colorType in CHANNELS) || !VALID_DEPTHS[colorType]!.includes(bitDepth)) {
        throw new Error(`unsupported PNG color type ${colorType} / bit depth ${bitDepth}`);
      }
      if (data[10] !== 0 || data[11] !== 0) throw new Error('unsupported PNG compression or filter method');
      if (data[12] !== 0 && data[12] !== 1) throw new Error('unsupported PNG interlace method');
      info = {
        width: u32(data, 0),
        height: u32(data, 4),
        bitDepth,
        colorType,
        interlaced: data[12] === 1,
      };
      if (headerOnly) break;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at = end + 4; // skip CRC
  }
  if (!info) throw new Error('PNG has no IHDR chunk');
  return { info, palette, transparency, idat };
}

/** Reads the header only. */
export function probePng(bytes: Uint8Array): PngInfo {
  return readChunks(bytes, true).info;
}

const ADAM7: Array<[xStart: number, yStart: number, xStep: number, yStep: number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses the scanline filter in place; `prior` is the previous unfiltered row (or zeros). */
function unfilter(type: number, row: Uint8Array, prior: Uint8Array, bpp: number): void {
  const n = row.length;
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) row[i] = (row[i]! + row[i - bpp]!) & 0xff;
      return;
    case 2:
      for (let i = 0; i < n; i++) row[i] = (row[i]! + prior[i]!) & 0xff;
      return;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        row[i] = (row[i]! + ((left + prior[i]!) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        const upLeft = i >= bpp ? prior[i - bpp]! : 0;
        row[i] = (row[i]! + paeth(left, prior[i]!, upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`invalid PNG filter type ${type}`);
  }
}

type RowConverter = (src: Uint8Array, width: number, out: Uint8Array | Uint8ClampedArray) => void;

function makeConverter(
  info: PngInfo,
  palette: Uint8Array | null,
  transparency: Uint8Array | null,
): RowConverter {
  const { bitDepth: depth, colorType } = info;
  const trns16 = (at: number) =>
    transparency && transparency.length >= at + 2 ? (transparency[at]! << 8) | transparency[at + 1]! : -1;

  if (colorType === 6) {
    if (depth === 8) {
      return (src, width, out) => {
        for (let i = 0; i < width * 4; i++) out[i] = src[i]!;
      };
    }
    return (src, width, out) => {
      for (let i = 0; i < width * 4; i++) out[i] = src[i * 2]!;
    };
  }
  if (colorType === 4) {
    const step = depth === 8 ? 2 : 4;
    return (src, width, out) => {
      for (let i = 0; i < width; i++) {
        const v = src[i * step]!;
        out[i * 4] = v;
        out[i * 4 + 1] = v;
        out[i * 4 + 2] = v;
        out[i * 4 + 3] = src[i * step + (depth === 8 ? 1 : 2)]!;
      }
    };
  }
  if (colorType === 2) {
    const keyR = trns16(0);
    const keyG = trns16(2);
    const keyB = trns16(4);
    const keyed = keyR >= 0 && keyG >= 0 && keyB >= 0;
    if (depth === 8) {
      return (src, width, out) => {
        for (let i = 0; i < width; i++) {
          const r = src[i * 3]!;
          const g = src[i * 3 + 1]!;
          const b = src[i * 3 + 2]!;
          out[i * 4] = r;
          out[i * 4 + 1] = g;
          out[i * 4 + 2] = b;
          out[i * 4 + 3] = keyed && r === keyR && g === keyG && b === keyB ? 0 : 255;
        }
      };
    }
    return (src, width, out) => {
      for (let i = 0; i < width; i++) {
        const o = i * 6;
        const r = (src[o]! << 8) | src[o + 1]!;
        const g = (src[o + 2]! << 8) | src[o + 3]!;
        const b = (src[o + 4]! << 8) | src[o + 5]!;
        out[i * 4] = src[o]!;
        out[i * 4 + 1] = src[o + 2]!;
        out[i * 4 + 2] = src[o + 4]!;
        out[i * 4 + 3] = keyed && r === keyR && g === keyG && b === keyB ? 0 : 255;
      }
    };
  }
  if (colorType === 3) {
    if (!palette) throw new Error('indexed PNG has no PLTE chunk');
    const mask = (1 << depth) - 1;
    return (src, width, out) => {
      for (let i = 0; i < width; i++) {
        const bit = i * depth;
        const idx = depth === 8 ? src[i]! : (src[bit >> 3]! >> (8 - depth - (bit & 7))) & mask;
        const p = idx * 3;
        out[i * 4] = palette[p] ?? 0;
        out[i * 4 + 1] = palette[p + 1] ?? 0;
        out[i * 4 + 2] = palette[p + 2] ?? 0;
        out[i * 4 + 3] = transparency && idx < transparency.length ? transparency[idx]! : 255;
      }
    };
  }
  // grayscale, 1-16 bits
  const key = trns16(0);
  const max = (1 << depth) - 1;
  return (src, width, out) => {
    for (let i = 0; i < width; i++) {
      let raw: number;
      if (depth === 16) raw = (src[i * 2]! << 8) | src[i * 2 + 1]!;
      else if (depth === 8) raw = src[i]!;
      else {
        const bit = i * depth;
        raw = (src[bit >> 3]! >> (8 - depth - (bit & 7))) & max;
      }
      const v = depth === 16 ? raw >> 8 : depth === 8 ? raw : Math.round((raw * 255) / max);
      out[i * 4] = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = key >= 0 && raw === key ? 0 : 255;
    }
  };
}

/**
 * Decodes a PNG (every color type and bit depth, Adam7 interlacing, `tRNS` transparency; APNG shows its
 * default image) and streams it into `sink`. The image data is inflated as it is read, one scanline at a time,
 * so the working set is a couple of rows however big the picture is; interlaced pictures arrive pass by pass
 * through `sink.pushSparse`. A truncated file keeps the rows that are there (a non-interlaced picture repeats its
 * last row to the bottom); corrupt data throws.
 */
export async function decodePng(
  bytes: Uint8Array,
  sink: RowSink,
  options: { maxPixels?: number } = {},
): Promise<PngInfo> {
  const { info, palette, transparency, idat } = readChunks(bytes, false);
  const { width, height, bitDepth, colorType, interlaced } = info;
  assertDimensions(width, height, options.maxPixels ?? DEFAULT_MAX_PIXELS);
  if (idat.length === 0) throw new Error('PNG has no image data');
  if (interlaced && !sink.pushSparse) throw new Error('this row sink cannot receive interlaced pictures');

  const bitsPerPixel = CHANNELS[colorType]! * bitDepth;
  const bpp = Math.max(1, Math.floor(bitsPerPixel / 8));
  const rowBytes = (w: number) => Math.ceil((w * bitsPerPixel) / 8);

  const passes = (
    interlaced
      ? ADAM7.map(([xs, ys, dx, dy]) => ({
          xs,
          ys,
          dx,
          dy,
          w: Math.ceil((width - xs) / dx),
          h: Math.ceil((height - ys) / dy),
        }))
      : [{ xs: 0, ys: 0, dx: 1, dy: 1, w: width, h: height }]
  )
    .filter((p) => p.w > 0 && p.h > 0)
    .map((p) => ({ ...p, bytesPerRow: rowBytes(p.w) }));

  const convert = makeConverter(info, palette, transparency);
  sink.begin(width, height);

  // the scanline being assembled (filter byte + row), the previous unfiltered one, and the converted RGBA row
  let passIndex = 0;
  let rowInPass = 0;
  let rowsDone = 0;
  let filled = 0;
  let current = new Uint8Array(1 + passes[0]!.bytesPerRow);
  let prior = new Uint8Array(1 + passes[0]!.bytesPerRow);
  let rgba = new Uint8Array((interlaced ? passes[0]!.w : width) * 4);

  const finishRow = (): void => {
    const pass = passes[passIndex]!;
    unfilter(current[0]!, current.subarray(1), prior.subarray(1), bpp);
    convert(current.subarray(1), pass.w, rgba);
    const y = pass.ys + rowInPass * pass.dy;
    if (interlaced) sink.pushSparse!(y, pass.xs, pass.dx, pass.w, rgba);
    else sink.push(y, rgba);
    [current, prior] = [prior, current];
    rowsDone++;
    if (++rowInPass === pass.h) {
      passIndex++;
      rowInPass = 0;
      const next = passes[passIndex];
      if (next) {
        current = new Uint8Array(1 + next.bytesPerRow);
        prior = new Uint8Array(1 + next.bytesPerRow);
        if (interlaced) rgba = new Uint8Array(next.w * 4);
      }
    }
  };

  const consume = (chunk: Uint8Array): void => {
    let at = 0;
    while (at < chunk.length && passIndex < passes.length) {
      const take = Math.min(chunk.length - at, current.length - filled);
      current.set(chunk.subarray(at, at + take), filled);
      filled += take;
      at += take;
      if (filled === current.length) {
        filled = 0;
        finishRow();
      }
    }
  };

  // Z_SYNC_FLUSH: a stream cut short ends quietly instead of failing
  const inflate = createInflate({ finishFlush: constants.Z_SYNC_FLUSH, chunkSize: 64 * 1024 });
  // Small writes: zlib inflates a whole write before it honours backpressure (Node 20 buffers all of it),
  // and deflate can expand ~1000x, so a 1 KiB slice keeps the window to about a megabyte.
  for (const part of idat) {
    for (let at = 0; at < part.length; at += INFLATE_WRITE) {
      inflate.write(part.subarray(at, at + INFLATE_WRITE));
    }
  }
  inflate.end();
  try {
    for await (const chunk of inflate) {
      consume(chunk as Uint8Array);
      if (passIndex >= passes.length) break; // the picture is complete; anything after it is ignored
    }
  } catch (error) {
    inflate.destroy();
    throw new Error(`corrupt PNG image data: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (passIndex < passes.length) {
    if (rowsDone === 0) throw new Error('PNG image data is truncated');
    // non-interlaced: repeat the last good row so the rest of the picture is not black
    if (!interlaced) for (let y = rowsDone; y < height; y++) sink.push(y, rgba);
  }
  return info;
}

const INFLATE_WRITE = 1024;

let crcTable: Int32Array | null = null;
function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) crc = crcTable[(crc ^ part[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32([out.subarray(4, 8), data]));
  return out;
}

/**
 * Encodes an RGBA bitmap as a PNG: RGB when fully opaque, RGBA otherwise, with an adaptive per-row filter
 * and maximum deflate. Meant for placeholder-sized images (tens of pixels wide).
 */
export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const line = new Uint8Array(stride);
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) line[x * channels + c] = rgba[(y * width + x) * 4 + c]!;
    }
    rows.push(line);
  }

  const zero = new Uint8Array(stride);
  const filtered = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const line = rows[y]!;
    const prior = y > 0 ? rows[y - 1]! : zero;
    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    const candidate = new Uint8Array(stride);
    for (let type = 0; type < 5; type++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? line[i - channels]! : 0;
        const upLeft = i >= channels ? prior[i - channels]! : 0;
        const predicted =
          type === 0
            ? 0
            : type === 1
              ? left
              : type === 2
                ? prior[i]!
                : type === 3
                  ? (left + prior[i]!) >> 1
                  : paeth(left, prior[i]!, upLeft);
        const value = (line[i]! - predicted) & 0xff;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = type;
        filtered.set(candidate, y * (1 + stride) + 1);
      }
    }
    filtered[y * (1 + stride)] = best;
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
