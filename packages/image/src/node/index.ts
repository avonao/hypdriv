import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { encodePlaceholder, renderPortable, UnsupportedImageError } from './portable';
import { loadWasmCodecs, type WasmCodecs } from './wasm';

export type { RasterFormat } from './portable';
export { sniffFormat } from './portable';
export type { WasmCodecs } from './wasm';
export { loadWasmCodecs } from './wasm';

/** Shape of `.hypdriv/placeholders.json`. */
export interface PlaceholdersFile {
  version: 1;
  generatedAt: string;
  /** Placeholder width in pixels. */
  size: number;
  /** Engine that produced the entries; a run with another engine, format or quality regenerates them. */
  engine?: PlaceholderEngineName;
  format?: PlaceholderFormat;
  quality?: number;
  /** `/`-prefixed public path → `data:image/webp;base64,…` (or `data:image/png;base64,…`). */
  placeholders: Record<string, string>;
  /** Per-source fingerprints used for incremental runs. */
  meta: Record<string, PlaceholderMeta>;
}

export interface PlaceholderMeta {
  mtimeMs: number;
  bytes: number;
  /** Original image dimensions. */
  width: number;
  height: number;
}

/** `sharp` is the native engine; `portable` is pure TypeScript with optional WebAssembly codecs. */
export type PlaceholderEngineName = 'sharp' | 'portable';
export type PlaceholderFormat = 'webp' | 'png';

export interface GeneratePlaceholdersOptions {
  /** Project root; relative paths resolve against it (default `process.cwd()`). */
  projectDir?: string;
  /** Directories served from the URL root, e.g. `['public']` (default). */
  sources?: string[];
  /** Placeholder width in pixels (default 16; height keeps the aspect ratio). */
  size?: number;
  /** Output file (default `.hypdriv/placeholders.json`). */
  file?: string;
  /** Parallel encodes (default 4). */
  concurrency?: number;
  /** WebP quality for the placeholder (default 40). */
  quality?: number;
  /**
   * `auto` (default) uses `sharp` when it is installed and the portable engine otherwise; `sharp` requires it
   * (skips with `sharp-missing` when absent); `portable` never loads native modules.
   */
  engine?: 'auto' | PlaceholderEngineName;
  /**
   * Output format. `auto` (default) is WebP when the engine can encode it (`sharp`, or `@jsquash/webp` for the
   * portable engine) and PNG otherwise.
   */
  format?: 'auto' | PlaceholderFormat;
  /** Injected `sharp` module (tests); default: dynamic `import('sharp')`. */
  sharp?: SharpLike | null;
  /** Injected WebAssembly codecs (tests); default: whichever `@jsquash/*` packages resolve from the project. */
  wasm?: WasmCodecs | null;
  /** Largest image the portable engine decodes, in pixels (default 134,217,728). */
  maxPixels?: number;
  /**
   * Plan only: decode and write nothing. `generated` then counts the images that would be (re)generated, so
   * `generated > 0 || removed > 0` means the file is out of date (CI freshness check).
   */
  dryRun?: boolean;
  /**
   * Portable engine only. `fast` (default) builds JPEG placeholders from the DC coefficients of big pictures,
   * like libjpeg's reduced-size decoding; `exact` decodes every JPEG completely.
   */
  accuracy?: 'fast' | 'exact';
  /** Extensions to consider (default png/jpg/jpeg/webp/avif/gif). */
  extensions?: string[];
  /** Directories skipped while walking (default node_modules, dot-directories). */
  ignore?: (relativePath: string) => boolean;
  log?: { info(message: string): void; warn(message: string): void };
}

export interface GeneratePlaceholdersResult {
  /** Newly encoded placeholders. */
  generated: number;
  /** Entries reused from the previous run (unchanged mtime and size). */
  reused: number;
  /** Entries dropped because their source disappeared. */
  removed: number;
  /** Entries in the written file. */
  total: number;
  /** Absolute path of the output file (unchanged when skipped). */
  file: string;
  /** Set when nothing could be generated. */
  skipped?: 'sharp-missing' | 'engine-missing' | 'no-sources';
  message?: string;
  /** The engine that ran (absent when skipped before one was chosen). */
  engine?: PlaceholderEngineName;
  /** Format of the generated entries. */
  format?: PlaceholderFormat;
  /** Files that failed to encode, with the error message. */
  errors: Array<{ path: string; error: string }>;
  /** Images left without a placeholder because no installed codec can decode them (WebP/AVIF without sharp). */
  unsupported: Array<{ path: string; reason: string }>;
}

/** Minimal structural type of the `sharp` module Hypdriv uses. */
export type SharpLike = (input: string | Buffer) => SharpInstanceLike;
export interface SharpInstanceLike {
  metadata(): Promise<{ width?: number; height?: number }>;
  resize(width: number, height?: number | null, options?: Record<string, unknown>): SharpInstanceLike;
  webp(options?: { quality?: number }): SharpInstanceLike;
  png?(options?: Record<string, unknown>): SharpInstanceLike;
  toBuffer(): Promise<Uint8Array>;
}

const DEFAULT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif'];

/** Tries to load `sharp`; `null` when it is not installed. */
export async function loadSharp(): Promise<SharpLike | null> {
  const specifier = 'sharp';
  try {
    const mod = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ specifier
    )) as { default?: unknown } | undefined;
    const candidate = (mod && 'default' in mod ? mod.default : mod) as unknown;
    return typeof candidate === 'function' ? (candidate as SharpLike) : null;
  } catch {
    return null;
  }
}

/** Reads an existing placeholders file; `null` when missing or unreadable. */
export async function readPlaceholdersFile(file: string): Promise<PlaceholdersFile | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<PlaceholdersFile>;
    if (parsed?.version !== 1 || typeof parsed.placeholders !== 'object') return null;
    return {
      version: 1,
      generatedAt: parsed.generatedAt ?? new Date(0).toISOString(),
      size: typeof parsed.size === 'number' ? parsed.size : 16,
      ...(parsed.engine === 'sharp' || parsed.engine === 'portable' ? { engine: parsed.engine } : {}),
      ...(parsed.format === 'webp' || parsed.format === 'png' ? { format: parsed.format } : {}),
      ...(typeof parsed.quality === 'number' ? { quality: parsed.quality } : {}),
      placeholders: parsed.placeholders ?? {},
      meta: parsed.meta ?? {},
    };
  } catch {
    return null;
  }
}

async function walk(
  dir: string,
  root: string,
  extensions: Set<string>,
  ignore: (rel: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    if (ignore(rel)) continue;
    if (entry.isDirectory()) out.push(...(await walk(full, root, extensions, ignore)));
    else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function defaultIgnore(rel: string): boolean {
  const last = rel.split('/').pop() ?? '';
  return last === 'node_modules' || last.startsWith('.');
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (index < items.length) {
      const item = items[index++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

const SHARP_MISSING_MESSAGE =
  'sharp is not installed; image placeholders were skipped. Run `pnpm add -D sharp` (optional peer of @hypdriv/image) to generate `.hypdriv/placeholders.json`.';

const WEBP_ENCODER_MISSING_MESSAGE =
  'format "webp" needs sharp or @jsquash/webp (optional peers of @hypdriv/image); use format "png" or "auto" to generate placeholders without them.';

const NO_CODECS: WasmCodecs = { decodeWebp: null, decodeAvif: null, encodeWebp: null, problems: {} };

/** One way to turn a file on disk into a placeholder `data:` URL. */
interface Renderer {
  name: PlaceholderEngineName;
  format: PlaceholderFormat;
  render(abs: string, bytes: number): Promise<{ dataUrl: string; width: number; height: number }>;
}

function sharpRenderer(sharp: SharpLike, format: PlaceholderFormat, size: number, quality: number): Renderer {
  return {
    name: 'sharp',
    format,
    async render(abs) {
      const dims = await sharp(abs).metadata();
      let pipeline = sharp(abs).resize(size, null, { fit: 'inside', withoutEnlargement: true });
      if (format === 'png') {
        const png = (pipeline as SharpInstanceLike).png;
        if (!png) throw new Error('this sharp build cannot encode PNG');
        pipeline = png.call(pipeline);
      } else {
        pipeline = pipeline.webp({ quality });
      }
      const buffer = await pipeline.toBuffer();
      return {
        dataUrl: `data:image/${format};base64,${Buffer.from(buffer).toString('base64')}`,
        width: dims.width ?? 0,
        height: dims.height ?? 0,
      };
    },
  };
}

function portableRenderer(
  codecs: WasmCodecs,
  format: PlaceholderFormat,
  size: number,
  quality: number,
  limits: { maxPixels?: number; accuracy?: 'fast' | 'exact' },
): Renderer {
  return {
    name: 'portable',
    format,
    async render(abs) {
      const bytes = await readFile(abs);
      const rendered = await renderPortable(bytes, {
        size,
        codecs,
        ...(limits.maxPixels ? { maxPixels: limits.maxPixels } : {}),
        ...(limits.accuracy ? { accuracy: limits.accuracy } : {}),
      });
      return {
        dataUrl: await encodePlaceholder(rendered.bitmap, format, quality, codecs),
        width: rendered.width,
        height: rendered.height,
      };
    },
  };
}

/**
 * Generates tiny blurred placeholders for raster images under the source directories and writes them to
 * `.hypdriv/placeholders.json`, keyed by `/`-prefixed public path (`public/hero.jpg` → `/hero.jpg`).
 *
 * Two engines produce them. `sharp` (optional native peer) handles every format and writes WebP. The
 * `portable` engine needs nothing native: PNG, JPEG (baseline and progressive) and GIF are decoded by
 * built-in TypeScript decoders and the result is a PNG, or a WebP when `@jsquash/webp` is installed, which
 * also lets it read WebP and AVIF sources (`@jsquash/webp`, `@jsquash/avif`). `engine: 'auto'` picks sharp
 * when present, so CI images without native modules still produce placeholders instead of skipping them.
 *
 * Incremental: sources whose size and mtime match the previous run (made with the same engine, format,
 * quality and size) are reused; vanished sources are removed. Missing optional engines never throw: the
 * function returns `{ generated: 0, skipped }` with an install hint.
 */
export async function generatePlaceholders(
  options: GeneratePlaceholdersOptions = {},
): Promise<GeneratePlaceholdersResult> {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const sources = (options.sources ?? ['public']).map((s) => resolve(projectDir, s));
  const size = Math.max(4, Math.min(64, Math.round(options.size ?? 16)));
  const quality = Math.max(1, Math.min(100, Math.round(options.quality ?? 40)));
  const file = resolve(projectDir, options.file ?? '.hypdriv/placeholders.json');
  const extensions = new Set(
    (options.extensions ?? DEFAULT_EXTENSIONS).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()),
  );
  const ignore = options.ignore ?? defaultIgnore;
  const errors: GeneratePlaceholdersResult['errors'] = [];
  const unsupported: GeneratePlaceholdersResult['unsupported'] = [];
  const skippedResult = (
    skipped: NonNullable<GeneratePlaceholdersResult['skipped']>,
    message?: string,
  ): GeneratePlaceholdersResult => ({
    generated: 0,
    reused: 0,
    removed: 0,
    total: 0,
    file,
    skipped,
    ...(message ? { message } : {}),
    errors,
    unsupported,
  });

  const requested = options.engine ?? 'auto';
  const sharp =
    requested === 'portable' ? null : options.sharp === undefined ? await loadSharp() : options.sharp;
  if (requested === 'sharp' && !sharp) {
    options.log?.warn(SHARP_MISSING_MESSAGE);
    return skippedResult('sharp-missing', SHARP_MISSING_MESSAGE);
  }

  let renderer: Renderer;
  if (sharp) {
    renderer = sharpRenderer(sharp, options.format === 'png' ? 'png' : 'webp', size, quality);
  } else {
    const codecs =
      options.wasm === undefined ? await loadWasmCodecs(projectDir) : (options.wasm ?? NO_CODECS);
    for (const [name, problem] of Object.entries(codecs.problems)) {
      options.log?.warn(`${name} could not be loaded (${problem}); continuing without it.`);
    }
    const wanted = options.format ?? 'auto';
    if (wanted === 'webp' && !codecs.encodeWebp) {
      options.log?.warn(WEBP_ENCODER_MISSING_MESSAGE);
      return skippedResult('engine-missing', WEBP_ENCODER_MISSING_MESSAGE);
    }
    const format: PlaceholderFormat = wanted === 'png' ? 'png' : codecs.encodeWebp ? 'webp' : 'png';
    renderer = portableRenderer(codecs, format, size, quality, {
      ...(options.maxPixels ? { maxPixels: options.maxPixels } : {}),
      ...(options.accuracy ? { accuracy: options.accuracy } : {}),
    });
  }

  const found = new Map<string, { abs: string; rel: string }>();
  for (const root of sources) {
    for (const abs of await walk(root, root, extensions, ignore)) {
      const rel = `/${relative(root, abs).split(sep).join('/')}`;
      if (!found.has(rel)) found.set(rel, { abs, rel });
    }
  }
  if (found.size === 0) {
    const message = `no raster images found under ${sources.map((s) => relative(projectDir, s) || '.').join(', ')}`;
    options.log?.info(message);
  }

  const previous = await readPlaceholdersFile(file);
  const samePreset =
    previous !== null &&
    previous.size === size &&
    previous.engine === renderer.name &&
    previous.format === renderer.format &&
    previous.quality === quality;
  const placeholders: Record<string, string> = {};
  const meta: Record<string, PlaceholderMeta> = {};
  let generated = 0;
  let reused = 0;
  const pending = new Set<string>();

  const jobs = [...found.values()];
  await runPool(jobs, options.concurrency ?? 4, async ({ abs, rel }) => {
    let info: { mtimeMs: number; size: number };
    try {
      const s = await stat(abs);
      info = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err) {
      errors.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const prevMeta = samePreset ? previous?.meta[rel] : undefined;
    const prevData = samePreset ? previous?.placeholders[rel] : undefined;
    if (prevMeta && prevData && prevMeta.mtimeMs === info.mtimeMs && prevMeta.bytes === info.size) {
      placeholders[rel] = prevData;
      meta[rel] = prevMeta;
      reused++;
      return;
    }
    if (options.dryRun) {
      pending.add(rel);
      generated++;
      return;
    }
    try {
      const out = await renderer.render(abs, info.size);
      placeholders[rel] = out.dataUrl;
      meta[rel] = { mtimeMs: info.mtimeMs, bytes: info.size, width: out.width, height: out.height };
      generated++;
    } catch (err) {
      if (err instanceof UnsupportedImageError) unsupported.push({ path: rel, reason: err.message });
      else errors.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
    }
  });
  unsupported.sort((a, b) => a.path.localeCompare(b.path));
  errors.sort((a, b) => a.path.localeCompare(b.path));
  if (unsupported.length > 0) {
    options.log?.warn(
      `${unsupported.length} image(s) have no placeholder because no installed codec can decode them (${[...new Set(unsupported.map((u) => u.reason.split(' ')[0]))].join(', ')}); install sharp, @jsquash/webp or @jsquash/avif.`,
    );
  }

  const removed = previous
    ? Object.keys(previous.placeholders).filter((key) => !(key in placeholders) && !pending.has(key)).length
    : 0;
  const ordered = Object.keys(placeholders).sort();
  const output: PlaceholdersFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    size,
    engine: renderer.name,
    format: renderer.format,
    quality,
    placeholders: Object.fromEntries(ordered.map((k) => [k, placeholders[k]!])),
    meta: Object.fromEntries(ordered.map((k) => [k, meta[k]!])),
  };

  if (found.size === 0 && !previous) {
    return { ...skippedResult('no-sources'), engine: renderer.name, format: renderer.format };
  }
  if (options.dryRun) {
    return {
      generated,
      reused,
      removed,
      total: ordered.length + pending.size,
      file,
      engine: renderer.name,
      format: renderer.format,
      errors,
      unsupported,
    };
  }

  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  options.log?.info(
    `placeholders (${renderer.name}, ${renderer.format}): ${generated} generated, ${reused} reused, ${removed} removed → ${relative(projectDir, file)}`,
  );
  return {
    generated,
    reused,
    removed,
    total: ordered.length,
    file,
    engine: renderer.name,
    format: renderer.format,
    errors,
    unsupported,
  };
}
