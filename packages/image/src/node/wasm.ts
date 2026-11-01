import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Optional WebAssembly codecs from the `@jsquash` family. They extend the portable placeholder engine with
 * WebP and AVIF decoding and a WebP encoder; PNG, JPEG and GIF never need them.
 *
 * jSquash is not an ESM-friendly Node citizen (its default `init()` fetches the `.wasm` file), so the module
 * is compiled from disk and handed to `init()` explicitly.
 */

export interface RawImage {
  width: number;
  height: number;
  /** 8-bit RGBA. */
  data: Uint8Array | Uint8ClampedArray;
}

export interface WasmCodecs {
  decodeWebp: ((bytes: Uint8Array) => Promise<RawImage>) | null;
  decodeAvif: ((bytes: Uint8Array) => Promise<RawImage>) | null;
  encodeWebp: ((image: RawImage, quality: number) => Promise<Uint8Array>) | null;
  /** Why a codec is unavailable, keyed by package name (only for packages that resolved but failed). */
  problems: Record<string, string>;
}

interface JsquashModule {
  init(module?: WebAssembly.Module): Promise<unknown>;
  default(input: unknown, options?: unknown): Promise<unknown>;
}

function resolvePackage(name: string, projectDir: string): string | null {
  const bases = [pathToFileURL(join(projectDir, 'package.json')).href, import.meta.url];
  for (const base of bases) {
    try {
      return dirname(createRequire(base).resolve(`${name}/package.json`));
    } catch {
      // try the next base
    }
  }
  return null;
}

async function compile(file: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await readFile(file));
}

/** `true` when this runtime runs WebAssembly SIMD (every supported Node version does). */
function hasSimd(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253,
        98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function loadDecoder(
  name: string,
  dir: string,
  wasmFile: string,
): Promise<(bytes: Uint8Array) => Promise<RawImage>> {
  const mod = (await import(pathToFileURL(join(dir, 'decode.js')).href)) as JsquashModule;
  await mod.init(await compile(join(dir, 'codec', 'dec', wasmFile)));
  return async (bytes) => {
    const image = (await mod.default(toArrayBuffer(bytes))) as RawImage;
    if (!image?.width || !image.height) throw new Error(`${name} could not decode the image`);
    return image;
  };
}

async function loadWebpEncoder(
  dir: string,
): Promise<(image: RawImage, quality: number) => Promise<Uint8Array>> {
  const mod = (await import(pathToFileURL(join(dir, 'encode.js')).href)) as JsquashModule;
  const variants = hasSimd() ? ['webp_enc_simd.wasm', 'webp_enc.wasm'] : ['webp_enc.wasm'];
  let lastError: unknown;
  for (const variant of variants) {
    try {
      await mod.init(await compile(join(dir, 'codec', 'enc', variant)));
      // prove the module works before promising it
      const probe = new Uint8ClampedArray(4 * 4 * 4).fill(255);
      await mod.default({ data: probe, width: 4, height: 4, colorSpace: 'srgb' }, { quality: 40 });
      return async (image, quality) => {
        const out = (await mod.default(
          {
            data: new Uint8ClampedArray(image.data),
            width: image.width,
            height: image.height,
            colorSpace: 'srgb',
          },
          { quality },
        )) as ArrayBuffer;
        return new Uint8Array(out);
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Loads whichever `@jsquash/webp` / `@jsquash/avif` packages the project (or Hypdriv) can resolve. */
export async function loadWasmCodecs(projectDir: string): Promise<WasmCodecs> {
  const codecs: WasmCodecs = { decodeWebp: null, decodeAvif: null, encodeWebp: null, problems: {} };

  const webp = resolvePackage('@jsquash/webp', projectDir);
  if (webp) {
    try {
      codecs.decodeWebp = await loadDecoder('@jsquash/webp', webp, 'webp_dec.wasm');
    } catch (error) {
      codecs.problems['@jsquash/webp'] = error instanceof Error ? error.message : String(error);
    }
    try {
      codecs.encodeWebp = await loadWebpEncoder(webp);
    } catch (error) {
      codecs.problems['@jsquash/webp (encoder)'] = error instanceof Error ? error.message : String(error);
    }
  }

  const avif = resolvePackage('@jsquash/avif', projectDir);
  if (avif) {
    try {
      codecs.decodeAvif = await loadDecoder('@jsquash/avif', avif, 'avif_dec.wasm');
    } catch (error) {
      codecs.problems['@jsquash/avif'] = error instanceof Error ? error.message : String(error);
    }
  }
  return codecs;
}
