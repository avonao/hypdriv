import { probeAvif } from './avif';
import { decodeGif, isGif, probeGif } from './gif';
import { decodeJpeg, estimateJpegBytes, isJpeg, jpegUsesDcOnly, probeJpeg } from './jpeg';
import { decodePng, encodePng, isPng, probePng } from './png';
import {
  assertDimensions,
  type Bitmap,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_PIXELS,
  Downscaler,
  ImageLimitError,
  planTarget,
  pushBitmap,
  type RowSink,
} from './raster';
import type { WasmCodecs } from './wasm';
import { firstWebpFrame, probeWebp } from './webp';

export type RasterFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif';

/** Identifies an image by its magic bytes (file extensions lie). `null` for anything else. */
export function sniffFormat(bytes: Uint8Array): RasterFormat | null {
  if (isPng(bytes)) return 'png';
  if (isJpeg(bytes)) return 'jpeg';
  if (isGif(bytes)) return 'gif';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'webp';
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    // `ftyp`: the major brand, a version, then the compatible brands. Encoders often write `mif1` as the major
    // brand and list `avif` among the compatible ones.
    const size = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    const end = Math.min(bytes.length, Math.max(size, 16));
    for (let at = 8; at + 4 <= end; at += at === 8 ? 8 : 4) {
      const brand = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
      if (brand === 'avif' || brand === 'avis') return 'avif';
    }
  }
  return null;
}

/** How many leading bytes `sniffFormat` needs to see every brand of a `ftyp` box (and any other signature). */
export const SNIFF_BYTES = 128;

/** The picture is a valid format that no installed decoder can read (WebP or AVIF without a WASM codec). */
export class UnsupportedImageError extends Error {
  override name = 'UnsupportedImageError';
  constructor(
    message: string,
    readonly format: RasterFormat,
  ) {
    super(message);
  }
}

export interface PortableRender {
  /** The placeholder pixels. */
  bitmap: Bitmap;
  /** Dimensions of the source image. */
  width: number;
  height: number;
  format: RasterFormat;
}

export interface PortableOptions {
  /** Placeholder width in pixels. */
  size: number;
  maxPixels?: number;
  /** Largest working set of one decode in bytes (default 1 GiB). */
  maxBytes?: number;
  /** `exact` decodes JPEGs completely instead of from their DC coefficients (slower, more memory). */
  accuracy?: 'fast' | 'exact';
  codecs: WasmCodecs;
  /** The result of `inspectPortable()` for the same bytes, when the caller already has it. */
  inspected?: PortableInspection;
}

/** What a picture is and what decoding it costs, known from its header alone. */
export interface PortableInspection {
  format: RasterFormat;
  width: number;
  height: number;
  /** Upper bound of the memory the decode holds, in bytes (the file itself not included). */
  estimate: number;
}

/** What `@jsquash` package a format needs, for diagnostics. */
const CODEC_PACKAGE: Partial<Record<RasterFormat, string>> = {
  webp: '@jsquash/webp',
  avif: '@jsquash/avif',
};

const missingCodec = (format: RasterFormat) =>
  new UnsupportedImageError(
    `${format.toUpperCase()} needs sharp or ${CODEC_PACKAGE[format]} to be decoded`,
    format,
  );

/**
 * Why the portable engine cannot decode the file that starts with `head` (`SNIFF_BYTES` is plenty), or `null`
 * when it can try: a WebP or AVIF picture without the matching `@jsquash` codec. Used to plan a run without
 * decoding.
 */
export function unsupportedBy(head: Uint8Array, codecs: WasmCodecs): UnsupportedImageError | null {
  const format = sniffFormat(head);
  if (format === 'webp' && !codecs.decodeWebp) return missingCodec(format);
  if (format === 'avif' && !codecs.decodeAvif) return missingCodec(format);
  return null;
}

const MIB = 1 << 20;

/**
 * Reads the header of `bytes` and refuses what the limits forbid before anything is allocated: impossible or
 * too large dimensions, and pictures whose decode would not fit the memory budget.
 */
export function inspectPortable(
  bytes: Uint8Array,
  options: Pick<PortableOptions, 'size' | 'maxPixels' | 'maxBytes' | 'accuracy' | 'codecs'>,
): PortableInspection {
  const format = sniffFormat(bytes);
  if (!format) throw new Error('not a PNG, JPEG, GIF, WebP or AVIF image');
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let width: number;
  let height: number;
  let estimate: number;
  switch (format) {
    case 'png': {
      ({ width, height } = probePng(bytes));
      assertDimensions(width, height, maxPixels);
      estimate = 4 * MIB + (width + height) * 40; // a few rows and the per-column tables: nothing else is held
      break;
    }
    case 'gif': {
      ({ width, height } = probeGif(bytes));
      assertDimensions(width, height, maxPixels);
      estimate = 4 * MIB + width * height + (width + height) * 40; // the palette indices of the frame
      break;
    }
    case 'jpeg': {
      const info = probeJpeg(bytes);
      ({ width, height } = info);
      assertDimensions(width, height, maxPixels);
      const target = planTarget(width, height, options.size);
      estimate = estimateJpegBytes(info, jpegUsesDcOnly(info, target, options.accuracy === 'exact'));
      break;
    }
    default: {
      if (format === 'webp' ? !options.codecs.decodeWebp : !options.codecs.decodeAvif)
        throw missingCodec(format);
      const dims = format === 'webp' ? probeWebp(bytes) : probeAvif(bytes);
      // without a readable header the size is only known after the decode, which is then checked as well
      ({ width, height } = dims ?? { width: 0, height: 0 });
      if (dims) assertDimensions(width, height, maxPixels);
      estimate = dims ? width * height * 8 + 8 * MIB : 64 * MIB; // RGBA out plus the codec's own copy
    }
  }
  if (estimate > maxBytes) {
    throw new ImageLimitError(
      `decoding this ${width}×${height} ${format.toUpperCase()} needs about ${Math.round(estimate / MIB)} MB, above the limit of ${Math.round(maxBytes / MIB)} MB${format === 'jpeg' && options.accuracy === 'exact' ? " (accuracy 'fast' reads big pictures from their DC coefficients and needs far less)" : ''}`,
    );
  }
  return { format, width, height, estimate };
}

/** Decodes `bytes` with the built-in decoders (or the optional WASM ones) and downscales to the placeholder. */
export async function renderPortable(bytes: Uint8Array, options: PortableOptions): Promise<PortableRender> {
  const inspected = options.inspected ?? inspectPortable(bytes, options);
  const { format } = inspected;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;

  if (format === 'webp' || format === 'avif') {
    const decode = format === 'webp' ? options.codecs.decodeWebp : options.codecs.decodeAvif;
    if (!decode) throw missingCodec(format);
    // libwebp's still-image decoder rejects animations: hand it the first frame as a stand-alone picture
    const source = format === 'webp' && probeWebp(bytes)?.animated ? (firstWebpFrame(bytes) ?? bytes) : bytes;
    const image = await decode(source);
    assertDimensions(image.width, image.height, maxPixels);
    const target = planTarget(image.width, image.height, options.size);
    const scaler = new Downscaler(target.width, target.height);
    pushBitmap(scaler, image.width, image.height, image.data);
    return { bitmap: scaler.finish(), width: image.width, height: image.height, format };
  }

  const { width, height } = inspected;
  const target = planTarget(width, height, options.size);
  const scaler: RowSink & { finish(): Bitmap } = new Downscaler(target.width, target.height);
  if (format === 'png') await decodePng(bytes, scaler, { maxPixels });
  else if (format === 'gif') decodeGif(bytes, scaler, { maxPixels });
  else {
    decodeJpeg(bytes, scaler, {
      targetWidth: target.width,
      targetHeight: target.height,
      maxPixels,
      ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
      exact: options.accuracy === 'exact',
    });
  }
  return { bitmap: scaler.finish(), width, height, format };
}

/** Encodes the placeholder bitmap as a `data:` URL: WebP when an encoder is given, PNG otherwise. */
export async function encodePlaceholder(
  bitmap: Bitmap,
  format: 'webp' | 'png',
  quality: number,
  codecs: WasmCodecs,
): Promise<string> {
  if (format === 'webp') {
    if (!codecs.encodeWebp) throw new Error('no WebP encoder available');
    const bytes = await codecs.encodeWebp(bitmap, quality);
    return `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`;
  }
  const bytes = encodePng(bitmap.data, bitmap.width, bitmap.height);
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}
