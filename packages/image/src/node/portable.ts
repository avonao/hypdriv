import { decodeGif, isGif, probeGif } from './gif';
import { decodeJpeg, isJpeg, probeJpeg } from './jpeg';
import { decodePng, encodePng, isPng, probePng } from './png';
import { type Bitmap, DEFAULT_MAX_PIXELS, Downscaler, planTarget, pushBitmap, type RowSink } from './raster';
import type { WasmCodecs } from './wasm';

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
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

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
  /** `exact` decodes JPEGs completely instead of from their DC coefficients (slower, more memory). */
  accuracy?: 'fast' | 'exact';
  codecs: WasmCodecs;
}

/** What `@jsquash` package a format needs, for diagnostics. */
const CODEC_PACKAGE: Partial<Record<RasterFormat, string>> = {
  webp: '@jsquash/webp',
  avif: '@jsquash/avif',
};

/** Decodes `bytes` with the built-in decoders (or the optional WASM ones) and downscales to the placeholder. */
export async function renderPortable(bytes: Uint8Array, options: PortableOptions): Promise<PortableRender> {
  const format = sniffFormat(bytes);
  if (!format) throw new Error('not a PNG, JPEG, GIF, WebP or AVIF image');
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;

  let width: number;
  let height: number;
  switch (format) {
    case 'png': {
      ({ width, height } = probePng(bytes));
      break;
    }
    case 'jpeg': {
      ({ width, height } = probeJpeg(bytes));
      break;
    }
    case 'gif': {
      ({ width, height } = probeGif(bytes));
      break;
    }
    default: {
      const decode = format === 'webp' ? options.codecs.decodeWebp : options.codecs.decodeAvif;
      if (!decode) {
        throw new UnsupportedImageError(
          `${format.toUpperCase()} needs sharp or ${CODEC_PACKAGE[format]} to be decoded`,
          format,
        );
      }
      const image = await decode(bytes);
      if (image.width * image.height > maxPixels) {
        throw new Error(`image has ${image.width * image.height} pixels, above the limit of ${maxPixels}`);
      }
      const target = planTarget(image.width, image.height, options.size);
      const scaler = new Downscaler(target.width, target.height);
      pushBitmap(scaler, image.width, image.height, image.data);
      return { bitmap: scaler.finish(), width: image.width, height: image.height, format };
    }
  }

  const target = planTarget(width, height, options.size);
  const scaler: RowSink & { finish(): Bitmap } = new Downscaler(target.width, target.height);
  if (format === 'png') decodePng(bytes, scaler, { maxPixels });
  else if (format === 'gif') decodeGif(bytes, scaler, { maxPixels });
  else {
    decodeJpeg(bytes, scaler, {
      targetWidth: target.width,
      targetHeight: target.height,
      maxPixels,
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
