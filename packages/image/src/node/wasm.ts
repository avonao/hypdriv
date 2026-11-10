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
 *
 * The encoder skips jSquash's `encode.js` and drives the Emscripten module directly: `encode.js` picks its glue
 * with `wasm-feature-detect`, whose 1.10 release contains `import.source(…)`, a syntax Node before 24 cannot
 * parse, so importing it fails on Node 20 and 22 although the codec itself runs there. Loading each glue file
 * with its own `.wasm` also keeps the SIMD and baseline builds from being mixed.
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

/** The Emscripten module of `@jsquash/webp`'s encoder (`codec/enc/webp_enc*.js`). */
interface WebpEncoderModule {
  encode(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options: Record<string, unknown>,
  ): Uint8Array | null;
}

interface EmscriptenFactory<T> {
  default(options: {
    noInitialRun: boolean;
    instantiateWasm: (
      imports: WebAssembly.Imports,
      callback: (instance: WebAssembly.Instance) => void,
    ) => WebAssembly.Exports;
  }): Promise<T>;
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
  const { defaultOptions } = (await import(pathToFileURL(join(dir, 'meta.js')).href)) as {
    defaultOptions: Record<string, unknown>;
  };
  const variants = hasSimd() ? ['webp_enc_simd', 'webp_enc'] : ['webp_enc'];
  let lastError: unknown;
  for (const variant of variants) {
    try {
      const glue = (await import(
        pathToFileURL(join(dir, 'codec', 'enc', `${variant}.js`)).href
      )) as EmscriptenFactory<WebpEncoderModule>;
      const wasm = await compile(join(dir, 'codec', 'enc', `${variant}.wasm`));
      const module = await glue.default({
        // the same settings as jSquash's initEmscriptenModule(): no main(), the module compiled above
        noInitialRun: true,
        instantiateWasm(imports, callback) {
          const instance = new WebAssembly.Instance(wasm, imports);
          callback(instance);
          return instance.exports;
        },
      });
      const encode = (image: RawImage, quality: number): Uint8Array => {
        const out = module.encode(new Uint8ClampedArray(image.data), image.width, image.height, {
          ...defaultOptions,
          quality,
        });
        if (!out) throw new Error('@jsquash/webp could not encode the image');
        // a copy, so the result never aliases WebAssembly memory
        return new Uint8Array(out);
      };
      // prove the module works before promising it
      encode({ data: new Uint8ClampedArray(4 * 4 * 4).fill(255), width: 4, height: 4 }, 40);
      return async (image, quality) => encode(image, quality);
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
