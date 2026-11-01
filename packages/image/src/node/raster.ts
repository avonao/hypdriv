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
  /**
   * Delivers `count` pixels of row `y` that sit at `x0`, `x0 + step`, `x0 + 2·step`, … (an Adam7 pass). Only
   * decoders of interlaced pictures call it; rows then arrive in any order and may never be complete (a
   * truncated file), and the sink treats the missing pixels as not part of the picture.
   */
  pushSparse?(y: number, x0: number, step: number, count: number, rgba: Uint8Array | Uint8ClampedArray): void;
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

/** No web picture is wider or taller than this; it also bounds the per-axis tables a decode allocates. */
export const MAX_DIMENSION = 1 << 20;

/** Default budget for the memory one decode may allocate (the working set, not the file itself): 1 GiB. */
export const DEFAULT_MAX_BYTES = 1 << 30;

export function assertDimensions(width: number, height: number, maxPixels: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new ImageLimitError(`invalid image dimensions ${width}×${height}`);
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ImageLimitError(
      `image is ${width}×${height}, above the limit of ${MAX_DIMENSION} pixels per side`,
    );
  }
  if (width * height > maxPixels) {
    throw new ImageLimitError(
      `image has ${width * height} pixels (${width}×${height}), above the limit of ${maxPixels}`,
    );
  }
}

/** A placeholder is never taller than this many times its width (a 1 × 100,000,000 strip stays small). */
export const MAX_PLACEHOLDER_ASPECT = 64;

/**
 * Placeholder dimensions for a source image: `size` px wide, never enlarged, aspect ratio kept, at most
 * `size × MAX_PLACEHOLDER_ASPECT` px tall.
 */
export function planTarget(width: number, height: number, size: number): { width: number; height: number } {
  if (!(width >= 1) || !(height >= 1))
    throw new ImageLimitError(`invalid image dimensions ${width}×${height}`);
  const w = Math.max(1, Math.min(size, width));
  const h = Math.max(1, Math.round((height * w) / width));
  return { width: w, height: Math.min(h, Math.ceil(size) * MAX_PLACEHOLDER_ASPECT) };
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
 * decoder never has to hold the full-size image, and holds only a table per source column: the row axis is
 * computed on the fly, so a picture a million rows tall costs no more than a short one.
 *
 * Pixels that never arrive (a truncated interlaced file) are not part of the picture: every target pixel is
 * normalised by the part of its area that was delivered.
 */
export class Downscaler implements RowSink {
  readonly width: number;
  readonly height: number;
  private readonly acc: Float64Array;
  private readonly line: Float64Array;
  private readonly lineCoverage: Float64Array;
  /** Per target row: the share of its height delivered through whole rows. */
  private readonly rowCoverage: Float64Array;
  /** Per target pixel: coverage delivered through sparse pushes (allocated on first use). */
  private sparseCoverage: Float64Array | null = null;
  private x: Axis | null = null;
  private srcWidth = 0;
  private srcHeight = 0;
  private cell = 1;
  private extentHeight = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.acc = new Float64Array(width * height * 4);
    this.line = new Float64Array(width * 4);
    this.lineCoverage = new Float64Array(width);
    this.rowCoverage = new Float64Array(height);
  }

  begin(width: number, height: number, extent?: GridExtent): void {
    this.srcWidth = width;
    this.srcHeight = height;
    this.cell = extent?.cell ?? 1;
    this.extentHeight = extent?.height ?? height;
    this.x = buildAxis(width, this.width, this.cell, extent?.width ?? width);
  }

  push(row: number, rgba: Uint8Array | Uint8ClampedArray): void {
    const x = this.x;
    if (!x) throw new Error('Downscaler.push() called before begin()');
    if (row < 0 || row >= this.srcHeight) return;
    const line = this.line;
    line.fill(0);
    for (let i = 0; i < this.srcWidth; i++) this.addPixel(x, i, rgba, i * 4, null);
    this.distribute(row, false);
  }

  pushSparse(
    row: number,
    x0: number,
    step: number,
    count: number,
    rgba: Uint8Array | Uint8ClampedArray,
  ): void {
    const x = this.x;
    if (!x) throw new Error('Downscaler.pushSparse() called before begin()');
    if (row < 0 || row >= this.srcHeight) return;
    const line = this.line;
    line.fill(0);
    this.lineCoverage.fill(0);
    for (let j = 0; j < count; j++) {
      const i = x0 + j * step;
      if (i >= this.srcWidth) break;
      this.addPixel(x, i, rgba, j * 4, this.lineCoverage);
    }
    this.distribute(row, true);
  }

  /** Adds source column `i` (its pixel starts at `at` in `rgba`) to the horizontal accumulator. */
  private addPixel(
    x: Axis,
    i: number,
    rgba: Uint8Array | Uint8ClampedArray,
    at: number,
    coverage: Float64Array | null,
  ): void {
    const line = this.line;
    const a = rgba[at + 3]! / 255;
    const base = x.offset[i]!;
    const n = x.count[i]!;
    if (coverage) {
      for (let k = 0; k < n; k++)
        coverage[x.first[i]! + k] = coverage[x.first[i]! + k]! + x.weights[base + k]!;
    }
    if (a === 0) return;
    const r = rgba[at]! * a;
    const g = rgba[at + 1]! * a;
    const b = rgba[at + 2]! * a;
    for (let k = 0; k < n; k++) {
      const w = x.weights[base + k]!;
      const o = (x.first[i]! + k) * 4;
      line[o] = line[o]! + r * w;
      line[o + 1] = line[o + 1]! + g * w;
      line[o + 2] = line[o + 2]! + b * w;
      line[o + 3] = line[o + 3]! + a * w;
    }
  }

  /** Spreads the finished horizontal accumulator over the target rows source row `row` overlaps. */
  private distribute(row: number, sparse: boolean): void {
    const T = this.height;
    const length = this.extentHeight;
    const lo = row * this.cell * T;
    const hi = Math.min((row + 1) * this.cell, length) * T;
    const t0 = Math.min(T - 1, Math.floor(lo / length));
    const t1 = Math.min(T - 1, Math.max(t0, Math.ceil(hi / length) - 1));
    const stride = this.width * 4;
    if (sparse && !this.sparseCoverage) this.sparseCoverage = new Float64Array(this.width * T);
    for (let t = t0; t <= t1; t++) {
      const w = Math.max(0, Math.min(hi, (t + 1) * length) - Math.max(lo, t * length)) / length;
      if (w === 0) continue;
      const target = t * stride;
      const line = this.line;
      for (let j = 0; j < stride; j++) this.acc[target + j] = this.acc[target + j]! + line[j]! * w;
      if (sparse) {
        const cov = this.sparseCoverage!;
        const base = t * this.width;
        for (let j = 0; j < this.width; j++) cov[base + j] = cov[base + j]! + this.lineCoverage[j]! * w;
      } else {
        this.rowCoverage[t] = this.rowCoverage[t]! + w;
      }
    }
  }

  /** The finished bitmap (straight alpha). */
  finish(): Bitmap {
    const data = new Uint8ClampedArray(this.width * this.height * 4);
    for (let ty = 0; ty < this.height; ty++) {
      for (let tx = 0; tx < this.width; tx++) {
        const index = ty * this.width + tx;
        const o = index * 4;
        const covered = this.rowCoverage[ty]! + (this.sparseCoverage ? this.sparseCoverage[index]! : 0);
        const a = this.acc[o + 3]!;
        if (covered < 1e-9 || a < 1e-9) continue;
        data[o] = Math.round(this.acc[o]! / a);
        data[o + 1] = Math.round(this.acc[o + 1]! / a);
        data[o + 2] = Math.round(this.acc[o + 2]! / a);
        data[o + 3] = Math.round((a / covered) * 255);
      }
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
