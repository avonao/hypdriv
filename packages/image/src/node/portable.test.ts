import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { probeAvif } from './avif';
import { MemoryBudget } from './budget';
import { decodeGif, probeGif } from './gif';
import { decodeJpeg, probeJpeg } from './jpeg';
import { decodePng, encodePng, probePng } from './png';
import {
  inspectPortable,
  renderPortable,
  SNIFF_BYTES,
  sniffFormat,
  UnsupportedImageError,
  unsupportedBy,
} from './portable';
import { type Bitmap, Downscaler, ImageLimitError, planTarget, pushBitmap } from './raster';
import type { WasmCodecs } from './wasm';
import { firstWebpFrame, probeWebp } from './webp';

const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const fixture = (name: string) => new Uint8Array(readFileSync(join(dir, name)));

interface Reference {
  width: number;
  height: number;
  target: [number, number];
  rgba: string;
}
const references = JSON.parse(readFileSync(join(dir, 'reference.json'), 'utf8')) as Record<
  string,
  Record<string, Reference>
>;

const NO_CODECS: WasmCodecs = { decodeWebp: null, decodeAvif: null, encodeWebp: null, problems: {} };

/** Largest and mean per-channel difference between a bitmap and the Pillow-derived reference. */
function diff(bitmap: Bitmap, reference: Reference): { max: number; mean: number } {
  expect([bitmap.width, bitmap.height]).toEqual(reference.target);
  const expected = Buffer.from(reference.rgba, 'base64');
  expect(bitmap.data.length).toBe(expected.length);
  let max = 0;
  let sum = 0;
  let samples = 0;
  for (let i = 0; i < expected.length; i += 4) {
    const alpha = Math.abs(bitmap.data[i + 3]! - expected[i + 3]!);
    max = Math.max(max, alpha);
    sum += alpha;
    samples++;
    // the colour of a fully transparent pixel is meaningless
    if (bitmap.data[i + 3] === 0 && expected[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(bitmap.data[i + c]! - expected[i + c]!);
      max = Math.max(max, d);
      sum += d;
      samples++;
    }
  }
  return { max, mean: sum / samples };
}
const maxDiff = (bitmap: Bitmap, reference: Reference) => diff(bitmap, reference).max;

async function render(name: string, size = 16, accuracy?: 'fast' | 'exact') {
  return renderPortable(fixture(name), { size, codecs: NO_CODECS, ...(accuracy ? { accuracy } : {}) });
}

describe('sniffFormat', () => {
  it('identifies images by their bytes, not their names', () => {
    expect(sniffFormat(fixture('png-rgb8.png'))).toBe('png');
    expect(sniffFormat(fixture('jpeg-420-baseline.jpg'))).toBe('jpeg');
    expect(sniffFormat(fixture('gif-static.gif'))).toBe('gif');
    expect(sniffFormat(fixture('webp-lossy.webp'))).toBe('webp');
    expect(sniffFormat(fixture('avif-lossy.avif'))).toBe('avif');
    expect(sniffFormat(new TextEncoder().encode('<svg></svg>'))).toBeNull();
    expect(sniffFormat(new Uint8Array(0))).toBeNull();
  });
});

describe('planTarget', () => {
  it('scales to the width, keeps the aspect ratio and never enlarges', () => {
    expect(planTarget(320, 200, 16)).toEqual({ width: 16, height: 10 });
    expect(planTarget(1000, 80, 16)).toEqual({ width: 16, height: 1 });
    expect(planTarget(8, 8, 16)).toEqual({ width: 8, height: 8 });
    expect(planTarget(40, 3000, 16)).toEqual({ width: 16, height: 1024 }); // never taller than 64× the width
  });
});

describe('Downscaler', () => {
  it('averages exactly: a 2×2 checker collapses to the mean', () => {
    const scaler = new Downscaler(1, 1);
    pushBitmap(
      scaler,
      2,
      2,
      new Uint8Array([0, 0, 0, 255, 200, 100, 50, 255, 200, 100, 50, 255, 0, 0, 0, 255]),
    );
    expect(Array.from(scaler.finish().data)).toEqual([100, 50, 25, 255]);
  });

  it('weights fractional coverage: 3 source pixels into 2 target pixels', () => {
    const scaler = new Downscaler(2, 1);
    pushBitmap(scaler, 3, 1, new Uint8Array([0, 0, 0, 255, 90, 90, 90, 255, 180, 180, 180, 255]));
    // target 0 = (0 + 0.5·90) / 1.5 = 30, target 1 = (0.5·90 + 180) / 1.5 = 150
    expect(Array.from(scaler.finish().data)).toEqual([30, 30, 30, 255, 150, 150, 150, 255]);
  });

  it('does not let transparent pixels bleed their colour', () => {
    const scaler = new Downscaler(1, 1);
    pushBitmap(scaler, 2, 1, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]));
    expect(Array.from(scaler.finish().data)).toEqual([255, 0, 0, 128]);
  });

  it('rejects rows before begin()', () => {
    expect(() => new Downscaler(1, 1).push(0, new Uint8Array(4))).toThrow(/before begin/);
  });
});

describe('PNG decoder', () => {
  const cases: Array<[file: string, colorType: number, depth: number, interlaced: boolean]> = [
    ['png-rgb8.png', 2, 8, false],
    ['png-rgba8.png', 6, 8, false],
    ['png-gray8.png', 0, 8, false],
    ['png-graya8.png', 4, 8, false],
    ['png-palette4.png', 3, 4, false],
    ['png-palette8-trns.png', 3, 8, false],
    ['png-gray1.png', 0, 1, false],
    ['png-gray2.png', 0, 2, false],
    ['png-gray4.png', 0, 4, false],
    ['png-gray16.png', 0, 16, false],
    ['png-rgb16.png', 2, 16, false],
    ['png-rgba16.png', 6, 16, false],
    ['png-rgb8-interlaced.png', 2, 8, true],
    ['png-rgba8-interlaced.png', 6, 8, true],
    ['png-gray4-interlaced.png', 0, 4, true],
    ['png-rgb8-interlaced-odd.png', 2, 8, true],
    ['png-rgb8-colorkey-filters.png', 2, 8, false],
  ];

  it.each(cases)('%s decodes exactly like Pillow', async (file, colorType, depth, interlaced) => {
    const info = probePng(fixture(file));
    expect({ colorType: info.colorType, depth: info.bitDepth, interlaced: info.interlaced }).toEqual({
      colorType,
      depth,
      interlaced,
    });
    const out = await render(file);
    expect(maxDiff(out.bitmap, references[file]!['16']!)).toBeLessThanOrEqual(1);
    expect([out.width, out.height]).toEqual([
      references[file]!['16']!.width,
      references[file]!['16']!.height,
    ]);
  });

  it('honours colour-key transparency and all five filter types', async () => {
    const out = await render('png-rgb8-colorkey-filters.png');
    expect(out.bitmap.data.some((v, i) => i % 4 === 3 && v < 255)).toBe(true);
  });

  it('decodes every filter variant ImageMagick writes', async () => {
    for (let n = 0; n < 5; n++) {
      const file = `png-rgb8-filter${n}.png`;
      expect(maxDiff((await render(file)).bitmap, references[file]!['16']!)).toBeLessThanOrEqual(1);
    }
  });

  it('streams rows one by one for non-interlaced images', async () => {
    const rows: number[] = [];
    await decodePng(fixture('png-rgb8.png'), {
      begin(width, height) {
        expect([width, height]).toEqual([96, 60]);
      },
      push(y) {
        rows.push(y);
      },
    });
    expect(rows).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it('keeps going through a truncated stream and fails cleanly on garbage', async () => {
    const bytes = fixture('png-rgb8.png');
    const truncated = bytes.subarray(0, Math.floor(bytes.length * 0.6));
    const scaler = new Downscaler(16, 10);
    await expect(decodePng(truncated, scaler)).resolves.toBeDefined();
    await expect(decodePng(new Uint8Array([1, 2, 3]), scaler)).rejects.toThrow(/not a PNG/);
    const corrupt = bytes.slice();
    corrupt.fill(0xaa, 60, 200);
    await expect(decodePng(corrupt, new Downscaler(16, 10))).rejects.toThrow(/corrupt PNG/);
  });

  it('refuses images over the pixel budget before allocating', async () => {
    await expect(
      decodePng(fixture('png-rgb8.png'), new Downscaler(4, 4), { maxPixels: 1000 }),
    ).rejects.toBeInstanceOf(ImageLimitError);
  });
});

describe('PNG encoder', () => {
  it('round-trips through the decoder (opaque → RGB, translucent → RGBA)', async () => {
    const rgb = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    const png = encodePng(rgb, 2, 2);
    expect(probePng(png)).toMatchObject({ width: 2, height: 2, colorType: 2, bitDepth: 8 });
    const scaler = new Downscaler(2, 2);
    await decodePng(png, scaler);
    expect(Array.from(scaler.finish().data)).toEqual(Array.from(rgb));

    const rgba = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 100, 70, 80, 90, 0, 100, 110, 120, 7]);
    const png2 = encodePng(rgba, 2, 2);
    expect(probePng(png2).colorType).toBe(6);
    const scaler2 = new Downscaler(2, 2);
    await decodePng(png2, scaler2);
    const back = scaler2.finish().data;
    expect(Array.from(back.slice(0, 8))).toEqual([10, 20, 30, 255, 40, 50, 60, 100]);
    expect(back[11]).toBe(0);
    expect(back[15]).toBe(7);
  });

  it('writes a valid, small file with correct chunk CRCs', () => {
    const data = new Uint8Array(16 * 9 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i * 3) & 255;
      data[i + 1] = 90;
      data[i + 2] = 200;
      data[i + 3] = 255;
    }
    const png = encodePng(data, 16, 9);
    expect(png.length).toBeLessThan(400);
    // verify each CRC against node's zlib implementation
    let at = 8;
    let chunks = 0;
    const crcOf = (bytes: Uint8Array) => {
      let crc = -1;
      for (const b of bytes) {
        let c = (crc ^ b) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = c ^ (crc >>> 8);
      }
      return (crc ^ -1) >>> 0;
    };
    while (at < png.length) {
      const view = new DataView(png.buffer, png.byteOffset + at);
      const length = view.getUint32(0);
      const crc = view.getUint32(8 + length);
      expect(crcOf(png.subarray(at + 4, at + 8 + length))).toBe(crc);
      at += 12 + length;
      chunks++;
    }
    expect(chunks).toBe(3);
    const idat = png.subarray(
      8 + 25 + 8,
      8 + 25 + 8 + new DataView(png.buffer, png.byteOffset + 33).getUint32(0),
    );
    expect(inflateSync(idat).length).toBe(9 * (1 + 16 * 3));
  });
});

describe('GIF decoder', () => {
  it.each(['gif-static.gif', 'gif-transparent.gif', 'gif-interlaced.gif', 'gif-animated.gif'])(
    '%s decodes exactly like Pillow (first frame)',
    async (file) => {
      expect(probeGif(fixture(file))).toMatchObject({
        width: references[file]!['16']!.width,
        height: references[file]!['16']!.height,
      });
      expect(maxDiff((await render(file)).bitmap, references[file]!['16']!)).toBeLessThanOrEqual(1);
    },
  );

  it('keeps transparency and handles the interlaced row order', async () => {
    const transparent = (await render('gif-transparent.gif')).bitmap;
    expect(transparent.data.some((v, i) => i % 4 === 3 && v < 255)).toBe(true);
    // interlaced files really are interlaced
    expect(
      fixture('gif-interlaced.gif').some((_, i, bytes) => bytes[i] === 0x2c && (bytes[i + 9]! & 0x40) !== 0),
    ).toBe(true);
  });

  it('refuses a frame bigger than the pixel budget before allocating it', () => {
    const bytes = fixture('gif-static.gif').slice();
    const frame = bytes.indexOf(0x2c, 13);
    bytes[frame + 5] = 0xff; // frame width 0xFFxx
    bytes[frame + 6] = 0xff;
    bytes[frame + 7] = 0xff; // frame height 0xFFxx
    bytes[frame + 8] = 0xff;
    expect(() => decodeGif(bytes, new Downscaler(4, 4))).toThrow(ImageLimitError);
  });

  it('rejects truncated and foreign files', () => {
    const bytes = fixture('gif-static.gif');
    expect(() => decodeGif(bytes.subarray(0, 40), new Downscaler(4, 4))).toThrow();
    expect(() => decodeGif(new Uint8Array(20), new Downscaler(4, 4))).toThrow(/not a GIF/);
  });
});

describe('JPEG decoder', () => {
  // [file, components, progressive]
  const files: Array<[string, number, boolean]> = [
    ['jpeg-444-baseline.jpg', 3, false],
    ['jpeg-420-baseline.jpg', 3, false],
    ['jpeg-422-baseline.jpg', 3, false],
    ['jpeg-440-baseline.jpg', 3, false],
    ['jpeg-420-progressive.jpg', 3, true],
    ['jpeg-444-progressive-optimized.jpg', 3, true],
    ['jpeg-420-restart.jpg', 3, false],
    ['jpeg-420-odd-large.jpg', 3, false],
    ['jpeg-gray.jpg', 1, false],
    ['jpeg-wide.jpg', 3, false],
    ['jpeg-cmyk.jpg', 4, false],
    ['jpeg-444-progressive-small.jpg', 3, true],
    ['jpeg-420-small-odd.jpg', 3, false],
    ['jpeg-gray-small.jpg', 1, false],
    ['jpeg-tiny.jpg', 3, false],
    ['jpeg-cmyk-small.jpg', 4, false],
  ];

  it.each(files)('%s: header', (file, components, progressive) => {
    expect(probeJpeg(fixture(file))).toMatchObject({
      width: references[file]!['16']!.width,
      height: references[file]!['16']!.height,
      components,
      progressive,
    });
  });

  it.each(files)('%s: the exact decode matches libjpeg', async (file) => {
    // entropy decoding (baseline, progressive refinement, restart intervals), dequantisation, IDCT,
    // fancy chroma upsampling and colour conversion all have to be right for this to hold
    const out = await render(file, 16, 'exact');
    const { max, mean } = diff(out.bitmap, references[file]!['16']!);
    expect(max).toBeLessThanOrEqual(4);
    expect(mean).toBeLessThanOrEqual(0.6);
  });

  // fast path: DC coefficients only. [file, max, mean] tolerances against the exact box average
  const fast: Array<[string, number, number]> = [
    ['jpeg-444-baseline.jpg', 14, 1.5],
    ['jpeg-444-progressive-optimized.jpg', 14, 1.5],
    ['jpeg-gray.jpg', 30, 4.5],
    ['jpeg-wide.jpg', 10, 1.5],
    ['jpeg-420-baseline.jpg', 45, 4],
    ['jpeg-420-progressive.jpg', 45, 4],
    ['jpeg-420-restart.jpg', 45, 4],
    ['jpeg-422-baseline.jpg', 40, 3],
    ['jpeg-440-baseline.jpg', 40, 3],
    ['jpeg-420-odd-large.jpg', 105, 15],
    ['jpeg-cmyk.jpg', 45, 6],
    // small pictures take the full path anyway
    ['jpeg-444-progressive-small.jpg', 3, 0.6],
    ['jpeg-420-small-odd.jpg', 4, 0.6],
    ['jpeg-tiny.jpg', 4, 0.6],
  ];
  it.each(fast)('%s: the DC-only fast path stays close to the box average', async (file, max, mean) => {
    const out = await render(file);
    const d = diff(out.bitmap, references[file]!['16']!);
    expect(d.max).toBeLessThanOrEqual(max);
    expect(d.mean).toBeLessThanOrEqual(mean);
  });

  it.each(['jpeg-gray.jpg', 'jpeg-444-baseline.jpg', 'jpeg-444-progressive-optimized.jpg'])(
    '%s: the DC grid is the exact 8×8 block means',
    (file) => {
      // baseline and progressive (DC successive approximation) must deliver the same grid
      const dc = references[file]!.dc as unknown as { grid: [number, number]; rgb: string };
      const bytes = fixture(file);
      const rows: Array<Uint8Array | Uint8ClampedArray> = [];
      let begun: unknown;
      const info = decodeJpeg(
        bytes,
        {
          begin(w, h, extent) {
            begun = [w, h, extent];
          },
          push(y, rgba) {
            rows[y] = rgba.slice();
          },
        },
        { targetWidth: 4, targetHeight: 2 },
      );
      expect(info.scale).toBe(8);
      expect(begun).toEqual([dc.grid[0], dc.grid[1], { cell: 8, width: info.width, height: info.height }]);
      const expected = Buffer.from(dc.rgb, 'base64');
      let worst = 0;
      for (let y = 0; y < dc.grid[1]; y++) {
        for (let x = 0; x < dc.grid[0]; x++) {
          for (let c = 0; c < 3; c++) {
            worst = Math.max(worst, Math.abs(rows[y]![x * 4 + c]! - expected[(y * dc.grid[0] + x) * 3 + c]!));
          }
        }
      }
      expect(worst).toBeLessThanOrEqual(file === 'jpeg-gray.jpg' ? 2 : 6);
    },
  );

  it('weights the partial last cell by the part of it inside the picture', () => {
    // 161×99 → a 21×13 grid whose last column stands for one pixel and last row for three
    const bytes = fixture('jpeg-420-odd-large.jpg');
    const extents: unknown[] = [];
    decodeJpeg(
      bytes,
      {
        begin(_w, _h, extent) {
          extents.push(extent);
        },
        push() {},
      },
      { targetWidth: 16, targetHeight: 10 },
    );
    expect(extents).toEqual([{ cell: 8, width: 161, height: 99 }]);
  });

  it('uses the DC-only path only when the target is at most 1/8 of the picture (and never when exact)', () => {
    const grids: number[][] = [];
    const run = (name: string, target: number, exact = false) => {
      const bytes = fixture(name);
      const info = probeJpeg(bytes);
      return decodeJpeg(
        bytes,
        {
          begin(w, h) {
            grids.push([w, h]);
          },
          push() {},
        },
        {
          targetWidth: target,
          targetHeight: Math.max(1, Math.round((info.height * target) / info.width)),
          exact,
        },
      );
    };
    expect(run('jpeg-420-baseline.jpg', 16).scale).toBe(8); // 320×200 → 40×25 grid
    expect(run('jpeg-420-baseline.jpg', 64).scale).toBe(1); // 320/8 = 40 < 64
    expect(run('jpeg-420-baseline.jpg', 16, true).scale).toBe(1);
    expect(run('jpeg-420-small-odd.jpg', 16).scale).toBe(1);
    expect(grids).toEqual([
      [40, 25],
      [320, 200],
      [320, 200],
      [37, 23],
    ]);
  });

  it('keeps going through truncated data and rejects unsupported variants', () => {
    const bytes = fixture('jpeg-420-progressive.jpg');
    expect(() =>
      decodeJpeg(bytes.subarray(0, Math.floor(bytes.length * 0.5)), new Downscaler(16, 10), {
        targetWidth: 16,
        targetHeight: 10,
      }),
    ).not.toThrow();
    // SOF9 = arithmetic coding
    const arithmetic = fixture('jpeg-444-baseline.jpg').slice();
    const sof = arithmetic.findIndex((_, i, a) => a[i] === 0xff && a[i + 1] === 0xc0);
    arithmetic[sof + 1] = 0xc9;
    expect(() => probeJpeg(arithmetic)).toThrow(/arithmetic/);
    // 12-bit precision
    const twelve = fixture('jpeg-444-baseline.jpg').slice();
    twelve[sof + 4] = 12;
    expect(() => probeJpeg(twelve)).toThrow(/precision/);
    expect(() => probeJpeg(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a JPEG/);
  });

  it('matches libjpeg at other target sizes', async () => {
    for (const [file, size] of [
      ['jpeg-420-baseline.jpg', '8'],
      ['jpeg-420-baseline.jpg', '32'],
      ['jpeg-444-baseline.jpg', '32'],
      ['jpeg-wide.jpg', '32'],
    ] as const) {
      const out = await render(file, Number(size), 'exact');
      expect(diff(out.bitmap, references[file]![size]!).max).toBeLessThanOrEqual(4);
    }
  });
});

describe('renderPortable', () => {
  it('never enlarges and keeps the source dimensions in the result', async () => {
    const out = await render('jpeg-tiny.jpg', 16);
    expect([out.bitmap.width, out.bitmap.height]).toEqual([8, 8]);
    expect([out.width, out.height]).toEqual([8, 8]);
    expect(out.format).toBe('jpeg');
  });

  it('reports WebP and AVIF as unsupported without the optional codecs, and non-images as errors', async () => {
    await expect(render('webp-lossy.webp')).rejects.toBeInstanceOf(UnsupportedImageError);
    await expect(render('webp-lossy.webp')).rejects.toThrow(/@jsquash\/webp/);
    await expect(render('avif-lossy.avif')).rejects.toThrow(/@jsquash\/avif/);
    await expect(
      renderPortable(new TextEncoder().encode('<svg/>'), { size: 16, codecs: NO_CODECS }),
    ).rejects.toThrow(/not a PNG, JPEG, GIF/);
  });

  it('decodes WebP and AVIF through injected codecs', async () => {
    const solid =
      (width: number, height: number): WasmCodecs['decodeWebp'] =>
      async () => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4).fill(200),
      });
    const out = await renderPortable(fixture('webp-lossy.webp'), {
      size: 4,
      codecs: { ...NO_CODECS, decodeWebp: solid(20, 10) },
    });
    expect([out.bitmap.width, out.bitmap.height]).toEqual([4, 2]);
    expect(Array.from(out.bitmap.data.slice(0, 4))).toEqual([200, 200, 200, 200]);
    expect([out.width, out.height, out.format]).toEqual([20, 10, 'webp']);
    await expect(
      renderPortable(fixture('webp-lossy.webp'), {
        size: 4,
        maxPixels: 100,
        codecs: { ...NO_CODECS, decodeWebp: solid(20, 10) },
      }),
    ).rejects.toThrow(/above the limit/);
  });
});

describe('robustness against damaged files', () => {
  // xorshift32: deterministic, so a failure is reproducible
  const rng = (seed: number) => () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
  const decoders = ['png', 'jpg', 'gif'] as const;
  const files = readdirSync(dir).filter((f) => decoders.some((ext) => f.endsWith(`.${ext}`)));

  it('either decodes or throws an Error for byte flips, truncation and junk, never hangs or throws strangers', async () => {
    const random = rng(0x5eed1234);
    let decoded = 0;
    let rejected = 0;
    for (const file of files) {
      const original = fixture(file);
      for (let round = 0; round < 25; round++) {
        const bytes = original.slice();
        const kind = round % 5;
        if (kind === 0) {
          for (let i = 0; i < 4; i++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
        } else if (kind === 1) {
          // damage the header area, where sizes and tables live
          for (let i = 0; i < 3; i++)
            bytes[Math.floor(random() * Math.min(bytes.length, 700))] = Math.floor(random() * 256);
        } else if (kind === 2) {
          bytes.fill(Math.floor(random() * 256), Math.floor(random() * bytes.length), bytes.length);
        } else if (kind === 3) {
          // splice garbage into the middle
          const at = Math.floor(random() * bytes.length);
          for (let i = at; i < Math.min(bytes.length, at + 40); i++) bytes[i] = Math.floor(random() * 256);
        }
        const input = kind === 4 ? bytes.subarray(0, Math.floor(random() * bytes.length)) : bytes;
        try {
          const out = await renderPortable(input, { size: 16, codecs: NO_CODECS, maxPixels: 4_000_000 });
          expect(out.bitmap.data.length).toBe(out.bitmap.width * out.bitmap.height * 4);
          decoded++;
        } catch (error) {
          expect(error, `${file} round ${round}`).toBeInstanceOf(Error);
          rejected++;
        }
      }
    }
    // damage must be survivable some of the time and detected some of the time
    expect(decoded).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(20);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
// Hostile and unusual input: crafted files that probe the limits, plus the container probes.
// ---------------------------------------------------------------------------------------------------------

const crc32 = (parts: Uint8Array[]): number => {
  let crc = -1;
  for (const part of parts) {
    for (const b of part) {
      let c = (crc ^ b) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = c ^ (crc >>> 8);
    }
  }
  return (crc ^ -1) >>> 0;
};

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32([out.subarray(4, 8), data]));
  return out;
}

/** A PNG file around a ready-made (still uncompressed) scanline stream. */
function pngFile(
  width: number,
  height: number,
  options: { colorType?: number; depth?: number; interlace?: number; raw?: Uint8Array },
): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = options.depth ?? 8;
  header[9] = options.colorType ?? 2;
  header[12] = options.interlace ?? 0;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(options.raw ?? new Uint8Array(0))),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Segments of a JPEG up to the first scan: `[marker, start, end)` triples. */
function jpegSegments(bytes: Uint8Array): Array<{ marker: number; start: number; end: number }> {
  const out: Array<{ marker: number; start: number; end: number }> = [];
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    out.push({ marker, start: at, end: at + 2 + length });
    if (marker === 0xda) break;
    at += 2 + length;
  }
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

describe('MemoryBudget', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('runs tasks side by side while they fit and queues the rest', async () => {
    const budget = new MemoryBudget(100);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(10);
      running--;
    };
    await Promise.all([40, 40, 40, 40, 40].map((bytes) => budget.run(bytes, task)));
    expect(peak).toBe(2);
  });

  it('lets a task above the limit run, alone', async () => {
    const budget = new MemoryBudget(100);
    const events: string[] = [];
    const big = budget.run(1_000, async () => {
      events.push('big start');
      await sleep(15);
      events.push('big end');
    });
    const small = budget.run(10, async () => {
      events.push('small');
    });
    await Promise.all([big, small]);
    expect(events).toEqual(['big start', 'big end', 'small']);
  });

  it('frees the share of a task that fails and returns what it returns', async () => {
    const budget = new MemoryBudget(50);
    await expect(
      budget.run(50, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(budget.run(50, async () => 'done')).resolves.toBe('done');
  });
});

describe('hostile PNG files', () => {
  it('refuses impossible and oversized dimensions from the header alone', async () => {
    const zero = pngFile(0, 0, {});
    expect(() => probePng(zero)).not.toThrow();
    await expect(renderPortable(zero, { size: 16, codecs: NO_CODECS })).rejects.toBeInstanceOf(
      ImageLimitError,
    );
    // far above anything a web picture is: stopped before any table is sized from it
    const tall = pngFile(1, 0x7fff_ffff, {});
    const wide = pngFile(0x7fff_ffff, 1, {});
    for (const bytes of [tall, wide]) {
      await expect(renderPortable(bytes, { size: 16, codecs: NO_CODECS })).rejects.toThrow(
        /per side|above the limit/,
      );
    }
    // one pixel wide but a hundred million tall: inside the pixel budget, yet above the per-side cap
    await expect(
      renderPortable(pngFile(1, 100_000_000, {}), { size: 16, codecs: NO_CODECS, maxPixels: 1e9 }),
    ).rejects.toThrow(/per side/);
  });

  it('streams a big picture through a bounded window instead of inflating it whole', async () => {
    // 4096 × 4096 grey: 16 MB of scanlines that deflate to a few KB
    const width = 4096;
    const rowBytes = 1 + width;
    const raw = new Uint8Array(rowBytes * width);
    for (let y = 0; y < width; y++) raw.fill(90 + (y % 7), y * rowBytes + 1, (y + 1) * rowBytes);
    const bytes = pngFile(width, width, { colorType: 0, raw });
    expect(bytes.length).toBeLessThan(200_000);

    const base = process.memoryUsage().arrayBuffers;
    let peak = 0;
    let rows = 0;
    const scaler = new Downscaler(16, 16);
    await decodePng(bytes, {
      begin: (w, h, extent) => scaler.begin(w, h, extent),
      push(y, rgba) {
        scaler.push(y, rgba);
        if (++rows % 128 === 0) peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
      },
    });
    expect(rows).toBe(width);
    // the whole raster would be 16 MB (+ the RGBA copy): a streaming decode stays far below
    expect(peak).toBeLessThan(8 * 1024 * 1024);
    const bitmap = scaler.finish();
    expect(bitmap.data[0]).toBeGreaterThanOrEqual(90);
    expect(bitmap.data[0]).toBeLessThanOrEqual(96);
  }, 30_000);

  it('does not darken or fade a truncated interlaced picture', async () => {
    // a uniform 16 × 16 colour, Adam7, with only the first four passes in the stream
    const size = 16;
    const passes: Array<[number, number, number, number]> = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ];
    const rows: number[] = [];
    for (const [xs, ys, dx, dy] of passes.slice(0, 4)) {
      const w = Math.ceil((size - xs) / dx);
      for (let y = ys; y < size; y += dy) {
        rows.push(0);
        for (let x = 0; x < w; x++) rows.push(200, 100, 50);
      }
    }
    const bytes = pngFile(size, size, { interlace: 1, raw: new Uint8Array(rows) });
    const out = await renderPortable(bytes, { size: 4, codecs: NO_CODECS });
    for (let i = 0; i < out.bitmap.data.length; i += 4) {
      expect(Array.from(out.bitmap.data.slice(i, i + 4))).toEqual([200, 100, 50, 255]);
    }
  });

  it('refuses a row sink that cannot take an interlaced picture, before reading any data', async () => {
    const bytes = fixture('png-rgb8-interlaced.png');
    await expect(decodePng(bytes, { begin() {}, push() {} })).rejects.toThrow(/interlaced/);
  });
});

describe('JPEG colour model and limits', () => {
  const plain = fixture('jpeg-444-baseline.jpg');
  const segments = jpegSegments(plain);
  const jfif = segments.find((s) => s.marker === 0xe0)!;
  const adobe = (transform: number) =>
    new Uint8Array([
      0xff,
      0xee,
      0x00,
      0x0e,
      0x41,
      0x64,
      0x6f,
      0x62,
      0x65,
      0x00,
      0x64,
      0x00,
      0x00,
      0x00,
      0x00,
      transform,
    ]);
  const withoutJfif = concat(plain.subarray(0, jfif.start), plain.subarray(jfif.end));
  const withAdobe = (bytes: Uint8Array, transform: number) =>
    concat(bytes.subarray(0, 2), adobe(transform), bytes.subarray(2));
  const pixels = async (bytes: Uint8Array) =>
    Array.from((await renderPortable(bytes, { size: 16, codecs: NO_CODECS, accuracy: 'exact' })).bitmap.data);

  it('lets JFIF win over an Adobe marker, like libjpeg', async () => {
    expect(segments.some((s) => s.marker === 0xe0)).toBe(true);
    const reference = await pixels(plain);
    expect(await pixels(withAdobe(plain, 0))).toEqual(reference);
    expect(await pixels(withAdobe(plain, 1))).toEqual(reference);
  });

  it('reads the Adobe transform when there is no JFIF marker, and the component ids otherwise', async () => {
    const reference = await pixels(plain);
    expect(await pixels(withoutJfif)).toEqual(reference); // ids 1, 2, 3 → YCbCr
    expect(await pixels(withAdobe(withoutJfif, 1))).toEqual(reference);
    const asRgb = await pixels(withAdobe(withoutJfif, 0));
    expect(asRgb).not.toEqual(reference); // the same bytes read as plain RGB
  });

  it('stops at 256 scans', () => {
    const progressive = fixture('jpeg-420-progressive.jpg');
    const sos = jpegSegments(progressive).find((s) => s.marker === 0xda)!;
    const scanHeader = progressive.subarray(sos.start, sos.end);
    const header = progressive.subarray(0, sos.start);
    const scans = Array.from({ length: 300 }, () => concat(scanHeader, new Uint8Array([0x00, 0x00])));
    const bytes = concat(header, ...scans, new Uint8Array([0xff, 0xd9]));
    expect(() => decodeJpeg(bytes, new Downscaler(16, 10), { targetWidth: 16, targetHeight: 10 })).toThrow(
      /more than 256 scans/,
    );
  });

  const patchSize = (bytes: Uint8Array, width: number, height: number) => {
    const out = bytes.slice();
    const sof = out.findIndex((_, i, a) => a[i] === 0xff && a[i + 1] === 0xc0);
    out[sof + 5] = height >> 8;
    out[sof + 6] = height & 255;
    out[sof + 7] = width >> 8;
    out[sof + 8] = width & 255;
    return out;
  };

  it('refuses a complete decode that would not fit the memory limit, with a hint', async () => {
    const huge = patchSize(plain, 16_000, 8_000); // 128 Mpixel: inside the pixel budget, 1.1 GB to decode
    const tooBig = renderPortable(huge, { size: 16, codecs: NO_CODECS, accuracy: 'exact' });
    await expect(tooBig).rejects.toBeInstanceOf(ImageLimitError);
    await expect(tooBig).rejects.toThrow(/accuracy 'fast'/);
    expect(() =>
      decodeJpeg(huge, new Downscaler(16, 8), { targetWidth: 16, targetHeight: 8, exact: true }),
    ).toThrow(ImageLimitError);
    // the same picture from its DC coefficients is a few MB
    expect(inspectPortable(huge, { size: 16, codecs: NO_CODECS }).estimate).toBeLessThan(64 * 1024 * 1024);
  });

  it('lets a header that promises more than the file holds run dry quickly', async () => {
    const lying = patchSize(plain, 4096, 4096);
    const out = await renderPortable(lying, { size: 16, codecs: NO_CODECS });
    expect([out.width, out.height]).toEqual([4096, 4096]);
    expect([out.bitmap.width, out.bitmap.height]).toEqual([16, 16]);
  }, 20_000);
});

describe('unusual GIF files', () => {
  const frameStart = (bytes: Uint8Array): number => {
    let at = 13 + (bytes[10]! & 0x80 ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0);
    while (bytes[at] === 0x21) {
      at += 2;
      while (bytes[at] !== 0) at += bytes[at]! + 1;
      at++;
    }
    expect(bytes[at]).toBe(0x2c);
    return at;
  };
  const gif = fixture('gif-static.gif');

  it('rejects a file that ends inside or right after the image descriptor', () => {
    const at = frameStart(gif);
    expect(() => decodeGif(gif.subarray(0, at + 10), new Downscaler(4, 4))).toThrow(/truncated/);
    expect(() => decodeGif(gif.subarray(0, at + 11), new Downscaler(4, 4))).toThrow(/empty or truncated/);
    expect(() => decodeGif(gif.subarray(0, at + 5), new Downscaler(4, 4))).toThrow();
  });

  it('rejects impossible LZW code sizes instead of looping or producing garbage', () => {
    const at = frameStart(gif);
    for (const size of [0, 1, 9, 12, 255]) {
      const bytes = gif.slice();
      bytes[at + 10] = size;
      expect(() => decodeGif(bytes, new Downscaler(4, 4))).toThrow(/code size/);
    }
  });

  it('takes the size of a 0×0 logical screen from the first frame', async () => {
    const zero = gif.slice();
    zero.fill(0, 6, 10);
    expect(probeGif(zero)).toEqual(probeGif(gif));
    const a = await renderPortable(zero, { size: 16, codecs: NO_CODECS });
    const b = await renderPortable(gif, { size: 16, codecs: NO_CODECS });
    expect(Array.from(a.bitmap.data)).toEqual(Array.from(b.bitmap.data));
  });
});

describe('WebP and AVIF headers', () => {
  it.each([
    ['webp-lossy.webp', false],
    ['webp-lossless.webp', false],
    ['webp-lossy-alpha.webp', false],
    ['webp-lossless-alpha.webp', false],
    ['webp-animated.webp', true],
  ])('%s: the canvas size comes from the container', (file, animated) => {
    const info = probeWebp(fixture(file));
    expect(info).toEqual({
      width: references[file]!['16']!.width,
      height: references[file]!['16']!.height,
      animated,
    });
  });

  it('reads AVIF sizes from the ispe property', () => {
    expect(probeAvif(fixture('avif-lossy.avif'))).toEqual({
      width: references['avif-lossy.avif']!['16']!.width,
      height: references['avif-lossy.avif']!['16']!.height,
    });
  });

  it('returns null for anything that is not a picture of the format', () => {
    expect(probeWebp(fixture('png-rgb8.png'))).toBeNull();
    expect(probeWebp(fixture('webp-lossy.webp').subarray(0, 15))).toBeNull();
    expect(probeAvif(fixture('png-rgb8.png'))).toBeNull();
    expect(probeAvif(new Uint8Array(0))).toBeNull();
    // a box claiming to be bigger than the file must not send the walk out of bounds
    const cut = fixture('avif-lossy.avif');
    expect(() => probeAvif(cut.subarray(0, cut.length >> 1))).not.toThrow();
  });

  it('cuts the first frame of an animation out as a stand-alone still picture', () => {
    const frame = firstWebpFrame(fixture('webp-animated.webp'))!;
    expect(frame).not.toBeNull();
    expect(sniffFormat(frame)).toBe('webp');
    const info = probeWebp(frame)!;
    expect(info.animated).toBe(false);
    expect(info.width).toBeGreaterThan(0);
    // RIFF length covers the file
    const riff = new DataView(frame.buffer, frame.byteOffset).getUint32(4, true);
    expect(riff).toBe(frame.length - 8);
    expect(firstWebpFrame(fixture('webp-lossy.webp'))).toBeNull();
  });

  it('refuses by the header, before a decoder allocates anything', async () => {
    let called = 0;
    const decodeWebp: WasmCodecs['decodeWebp'] = async () => {
      called++;
      return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    };
    const codecs: WasmCodecs = { ...NO_CODECS, decodeWebp, decodeAvif: decodeWebp };
    for (const file of ['webp-lossy.webp', 'avif-lossy.avif']) {
      await expect(renderPortable(fixture(file), { size: 4, maxPixels: 100, codecs })).rejects.toBeInstanceOf(
        ImageLimitError,
      );
      await expect(renderPortable(fixture(file), { size: 4, maxBytes: 1024, codecs })).rejects.toBeInstanceOf(
        ImageLimitError,
      );
    }
    expect(called).toBe(0);
  });

  it('plans a run from the header bytes alone', () => {
    const head = (file: string) => fixture(file).subarray(0, SNIFF_BYTES);
    expect(unsupportedBy(head('webp-lossy.webp'), NO_CODECS)).toBeInstanceOf(UnsupportedImageError);
    expect(unsupportedBy(head('avif-lossy.avif'), NO_CODECS)).toBeInstanceOf(UnsupportedImageError);
    expect(unsupportedBy(head('png-rgb8.png'), NO_CODECS)).toBeNull();
    expect(
      unsupportedBy(head('webp-lossy.webp'), { ...NO_CODECS, decodeWebp: async () => null as never }),
    ).toBeNull();
  });
});

describe('sniffFormat and AVIF brands', () => {
  const ftyp = (...brands: string[]) => {
    const body = brands.flatMap((b) => Array.from(b, (c) => c.charCodeAt(0)));
    // size, 'ftyp', major brand, minor version, compatible brands
    const size = 8 + body.length + 4;
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    out.set([0x66, 0x74, 0x79, 0x70], 4);
    const [major, ...compatible] = brands;
    out.set(
      Array.from(major!, (c) => c.charCodeAt(0)),
      8,
    );
    let at = 16;
    for (const brand of compatible) {
      out.set(
        Array.from(brand, (c) => c.charCodeAt(0)),
        at,
      );
      at += 4;
    }
    return out;
  };

  it('finds avif among the compatible brands of a mif1 file', () => {
    expect(sniffFormat(ftyp('mif1', 'mif1', 'avif', 'miaf'))).toBe('avif');
    expect(sniffFormat(ftyp('avis', 'avis'))).toBe('avif');
    expect(sniffFormat(ftyp('avif'))).toBe('avif');
  });

  it('does not take other ISO media files for AVIF', () => {
    expect(sniffFormat(ftyp('mif1', 'mif1', 'heic'))).toBeNull();
    expect(sniffFormat(ftyp('isom', 'isom', 'mp42'))).toBeNull();
    expect(sniffFormat(ftyp('M4A ', 'M4A ', 'mp42'))).toBeNull();
  });
});
