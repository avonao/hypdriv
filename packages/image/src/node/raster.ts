/**
 * Raster plumbing shared by the portable (sharp-free) placeholder engine: a row sink that decoders
 * stream into, and an exact area-average downscaler that implements it.
 */

/** Receives decoded rows, top to bottom. Rows are 8-bit RGBA, `width * 4` bytes. */
export interface RowSink {
  /**
   * Called once before the first row with the dimensions of the grid the decoder will deliver. When the grid
   * is coarser than the picture (a JPEG decoded from its DC coefficients delivers one cell per 8×8 pixels)
   * `extent` says how many pixels a cell stands for and how big the real picture is, so the last, partial
   * cell is weighted by the part of it that is inside the picture.
   */
  begin(width: number, height: number, extent?: GridExtent): void;
  push(y: number, rgba: Uint8Array | Uint8ClampedArray): void;
}

/** Geometry of a coarse grid: each cell stands for `cell × cell` pixels of a `width × height` picture. */
export interface GridExtent {
  cell: number;
  width: number;
  height: number;
}

/** Tiny RGBA bitmap. */
export interface Bitmap {
  width: number;
  height: number;
  /** `width * height * 4` bytes, straight (non-premultiplied) alpha. */
  data: Uint8ClampedArray;
}

/** Image bigger than the configured pixel budget, or with impossible dimensions. */
export class ImageLimitError extends Error {
  override name = 'ImageLimitError';
}

/** Default pixel budget for one decode (about 16k × 8k). Keeps memory bounded on hostile or corrupt files. */
export const DEFAULT_MAX_PIXELS = 134_217_728;

export function assertDimensions(width: number, height: number, maxPixels: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new ImageLimitError(`invalid image dimensions ${width}×${height}`);
  }
  if (width * height > maxPixels) {
    throw new ImageLimitError(
      `image has ${width * height} pixels (${width}×${height}), above the limit of ${maxPixels}`,
    );
  }
}

/** Placeholder dimensions for a source image: `size` px wide, never enlarged, aspect ratio kept. */
export function planTarget(width: number, height: number, size: number): { width: number; height: number } {
  const w = Math.max(1, Math.min(size, width));
  return { width: w, height: Math.max(1, Math.round((height * w) / width)) };
}

interface Axis {
  /** Per source index: first target index. */
  first: Int32Array;
  /** Per source index: number of target cells it touches. */
  count: Int32Array;
  /** Flattened weights (`sum(count)` entries); weight = overlap / source length. */
  weights: Float64Array;
  /** Per source index: offset into `weights`. */
  offset: Int32Array;
}

/**
 * Source cell `i` covers `[i·cell, min((i+1)·cell, length))` pixels and target cell `t` covers
 * `[t·length/target, (t+1)·length/target)`; scaled by `target` both are integers, and the overlap divided by
 * `length` is the share of the target cell.
 */
function buildAxis(cells: number, target: number, cell: number, length: number): Axis {
  const first = new Int32Array(cells);
  const count = new Int32Array(cells);
  const offset = new Int32Array(cells);
  let total = 0;
  for (let i = 0; i < cells; i++) {
    const lo = i * cell * target;
    const hi = Math.min((i + 1) * cell, length) * target;
    const t0 = Math.min(target - 1, Math.floor(lo / length));
    const t1 = Math.min(target - 1, Math.max(t0, Math.ceil(hi / length) - 1));
    first[i] = t0;
    count[i] = t1 - t0 + 1;
    offset[i] = total;
    total += count[i]!;
  }
  const weights = new Float64Array(total);
  for (let i = 0; i < cells; i++) {
    const lo = i * cell * target;
    const hi = Math.min((i + 1) * cell, length) * target;
    for (let k = 0; k < count[i]!; k++) {
      const t = first[i]! + k;
      const overlap = Math.min(hi, (t + 1) * length) - Math.max(lo, t * length);
      weights[offset[i]! + k] = Math.max(0, overlap) / length;
    }
  }
  return { first, count, weights, offset };
}

/**
 * Area-average downscaler. Each target pixel is the exact coverage-weighted mean of the source pixels it
 * spans (premultiplied by alpha, so transparent pixels do not bleed their colour). Works row by row, so a
 * decoder never has to hold the full-size image.
 */
export class Downscaler implements RowSink {
  readonly width: number;
  readonly height: number;
  private readonly acc: Float64Array;
  private readonly line: Float64Array;
  private x: Axis | null = null;
  private y: Axis | null = null;
  private srcWidth = 0;
  private srcHeight = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.acc = new Float64Array(width * height * 4);
    this.line = new Float64Array(width * 4);
  }

  begin(width: number, height: number, extent?: GridExtent): void {
    this.srcWidth = width;
    this.srcHeight = height;
    const cell = extent?.cell ?? 1;
    this.x = buildAxis(width, this.width, cell, extent?.width ?? width);
    this.y = buildAxis(height, this.height, cell, extent?.height ?? height);
  }

  push(row: number, rgba: Uint8Array | Uint8ClampedArray): void {
    const x = this.x;
    const y = this.y;
    if (!x || !y) throw new Error('Downscaler.push() called before begin()');
    if (row < 0 || row >= this.srcHeight) return;
    const line = this.line;
    line.fill(0);
    for (let i = 0; i < this.srcWidth; i++) {
      const a = rgba[i * 4 + 3]! / 255;
      if (a === 0) continue;
      const r = rgba[i * 4]! * a;
      const g = rgba[i * 4 + 1]! * a;
      const b = rgba[i * 4 + 2]! * a;
      const base = x.offset[i]!;
      for (let k = 0, n = x.count[i]!; k < n; k++) {
        const w = x.weights[base + k]!;
        const o = (x.first[i]! + k) * 4;
        line[o] = line[o]! + r * w;
        line[o + 1] = line[o + 1]! + g * w;
        line[o + 2] = line[o + 2]! + b * w;
        line[o + 3] = line[o + 3]! + a * w;
      }
    }
    const rowBase = y.offset[row]!;
    const stride = this.width * 4;
    for (let k = 0, n = y.count[row]!; k < n; k++) {
      const w = y.weights[rowBase + k]!;
      const target = (y.first[row]! + k) * stride;
      for (let j = 0; j < stride; j++) this.acc[target + j] = this.acc[target + j]! + line[j]! * w;
    }
  }

  /** The finished bitmap (straight alpha). */
  finish(): Bitmap {
    const data = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.width * this.height; i++) {
      const o = i * 4;
      const a = this.acc[o + 3]!;
      if (a < 1e-9) continue;
      data[o] = Math.round(this.acc[o]! / a);
      data[o + 1] = Math.round(this.acc[o + 1]! / a);
      data[o + 2] = Math.round(this.acc[o + 2]! / a);
      data[o + 3] = Math.round(a * 255);
    }
    return { width: this.width, height: this.height, data };
  }
}

/** Feeds a complete RGBA buffer (WASM decoders return the whole image) through a sink. */
export function pushBitmap(
  sink: RowSink,
  width: number,
  height: number,
  data: Uint8Array | Uint8ClampedArray,
) {
  sink.begin(width, height);
  const stride = width * 4;
  for (let y = 0; y < height; y++) sink.push(y, data.subarray(y * stride, (y + 1) * stride));
}
