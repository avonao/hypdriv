# ADR 0026 — Placeholders have a portable engine: built-in decoders, optional WebAssembly codecs

**Status:** accepted · **Date:** 2026-11-01

## Context

`generatePlaceholders()` needed `sharp`, a native module. CI images, locked-down build hosts and minimal containers often cannot install or run one, and the function answered `skipped: 'sharp-missing'`: no placeholders, silently, in exactly the environments that ship to production. A zero-infrastructure baseline (ADR 0004) should hold for the build step too. The inputs are the images in `public/`: mostly JPEG and PNG, some GIF, increasingly WebP and AVIF. The output is a 16-pixel picture.

## Decision

1. **Two engines behind one function.** `engine: 'auto'` (default) uses `sharp` when it resolves and the portable engine otherwise; `'sharp'` and `'portable'` force one. A missing optional engine never throws; it returns `skipped` with the package to install.
2. **The portable engine decodes in TypeScript.** PNG (every color type and bit depth, Adam7, `tRNS`), GIF (first frame) and JPEG (baseline, extended sequential and progressive Huffman; any subsampling; restart intervals; grayscale, YCbCr, RGB, CMYK, YCCK) are small, well specified and cheap to decode into a 16-pixel result, so no dependency is needed. Arithmetic-coded, lossless and 12-bit JPEGs are rejected with a clear error.
3. **Decoders stream into an area-average downscaler.** Rows go straight into a coverage-weighted, alpha-premultiplied accumulator the size of the placeholder, so a large PNG never exists as a full RGBA bitmap, and the pixel budget (`maxPixels`) is checked before any allocation.
4. **Big JPEGs are decoded from their DC coefficients.** A block's DC value is the exact mean of its 8×8 pixels, so the target is reached without an IDCT and progressive files skip every AC scan. This is what libjpeg's reduced-size decoding does, and so what sharp's shrink-on-load does; `accuracy: 'exact'` forces the full decode. Pictures under eight times the placeholder always take the full path, whose output matches libjpeg to within a level or two (fancy chroma upsampling included).
5. **WebP and AVIF come from optional WebAssembly codecs.** Writing a VP8/AV1 decoder in TypeScript is not proportionate; `@jsquash/webp` and `@jsquash/avif` are compiled once from the file and initialised explicitly (their default loader uses `fetch`, which does not work in Node), resolved from the project first. Without them those files are `unsupported` (reported, not failed). With `@jsquash/webp` the placeholder is a WebP; without it, a PNG written by a 100-line encoder (adaptive filters, level-9 deflate, a few hundred bytes), which `blurDataURL` accepts like any `data:image/*`.
6. **The file records how it was made.** `engine`, `format` and `quality` join `size` in `.hypdriv/placeholders.json`; a run with different settings regenerates instead of reusing entries from another engine.
7. **Fixtures come from independent decoders.** The tests compare against Pillow/libjpeg/ImageMagick output (`__fixtures__/generate.py` regenerates the files and the reference), including real WebP/AVIF through the actual codecs, and against sharp when it is installed.

## Consequences

- Placeholders work on any Node >= 20.9 without native code; `hypdriv placeholders --check` can gate CI on them.
- About 1,200 lines of decoder code live in `@hypdriv/image/node` and must be maintained; the surface is frozen formats and the fixture suite is the safety net.
- The DC-only path is an approximation near sharp colour edges of chroma-subsampled pictures (visible only as a slightly different 16-pixel blur); `accuracy: 'exact'` is the escape hatch.
- Animated images use their first frame; ICC profiles and EXIF orientation are ignored, as with the sharp path.
