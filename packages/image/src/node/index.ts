import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { MemoryBudget } from './budget';
import {
  encodePlaceholder,
  inspectPortable,
  renderPortable,
  SNIFF_BYTES,
  UnsupportedImageError,
  unsupportedBy,
} from './portable';
import { DEFAULT_MAX_BYTES } from './raster';
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
  /** Portable engine only: `exact` entries were decoded completely, `fast` ones from DC coefficients. */
  accuracy?: 'fast' | 'exact';
  /** `/`-prefixed public path → `data:image/webp;base64,…` (or `data:image/png;base64,…`). */
  placeholders: Record<string, string>;
  /** Per-source fingerprints used for incremental runs. */
  meta: Record<string, PlaceholderMeta>;
}

export interface PlaceholderMeta {
  mtimeMs: number;
  bytes: number;
  /** SHA-256 of the source (first 128 bits, base64url): lets a fresh checkout, which resets every mtime, reuse entries. */
  hash?: string;
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
   * Memory the portable engine may use for decoding, in bytes (default 1 GiB): a picture whose decode needs more
   * is refused, and parallel decodes wait for each other instead of adding up.
   */
  maxMemory?: number;
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
      ...(parsed.accuracy === 'fast' || parsed.accuracy === 'exact' ? { accuracy: parsed.accuracy } : {}),
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
  /** Portable engine: how big pictures were decoded. */
  accuracy?: 'fast' | 'exact';
  render(abs: string, bytes: number): Promise<{ dataUrl: string; width: number; height: number }>;
  /** Cheap look at the file header: the reason `render` would report the picture as unsupported, else `null`. */
  precheck?(abs: string): Promise<UnsupportedImageError | null>;
}

async function readHead(abs: string, length: number): Promise<Uint8Array> {
  const handle = await open(abs, 'r');
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
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
  limits: { maxPixels?: number; maxBytes: number; accuracy: 'fast' | 'exact' },
): Renderer {
  const budget = new MemoryBudget(limits.maxBytes);
  const options = {
    size,
    codecs,
    maxBytes: limits.maxBytes,
    accuracy: limits.accuracy,
    ...(limits.maxPixels ? { maxPixels: limits.maxPixels } : {}),
  };
  return {
    name: 'portable',
    format,
    accuracy: limits.accuracy,
    async precheck(abs) {
      return unsupportedBy(await readHead(abs, SNIFF_BYTES), codecs);
    },
    async render(abs) {
      const bytes = await readFile(abs);
      // the header says what the decode costs; parallel decodes wait until they fit the budget together
      const inspected = inspectPortable(bytes, options);
      const rendered = await budget.run(inspected.estimate, () =>
        renderPortable(bytes, { ...options, inspected }),
      );
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
      maxBytes: options.maxMemory ?? DEFAULT_MAX_BYTES,
      accuracy: options.accuracy ?? 'fast',
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
  const canReuse = reusable(
    previous,
    { size, engine: renderer.name, format: renderer.format, quality, accuracy: renderer.accuracy ?? 'fast' },
    { engine: requested !== 'auto', format: (options.format ?? 'auto') !== 'auto' },
  );
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
    const prevMeta = canReuse ? previous?.meta[rel] : undefined;
    const prevData = canReuse ? previous?.placeholders[rel] : undefined;
    if (prevMeta && prevData && prevMeta.bytes === info.size) {
      // same size and timestamp, or (a fresh checkout resets every mtime) same content
      const unchanged =
        prevMeta.mtimeMs === info.mtimeMs ||
        (prevMeta.hash !== undefined && (await hashFile(abs).catch(() => null)) === prevMeta.hash);
      if (unchanged) {
        placeholders[rel] = prevData;
        meta[rel] = prevMeta;
        reused++;
        return;
      }
    }
    if (options.dryRun) {
      // a picture no installed codec reads never gets an entry: it is not "out of date" either
      const reason = await renderer.precheck?.(abs).catch(() => null);
      if (reason) {
        unsupported.push({ path: rel, reason: reason.message });
        return;
      }
      pending.add(rel);
      generated++;
      return;
    }
    try {
      const out = await renderer.render(abs, info.size);
      placeholders[rel] = out.dataUrl;
      meta[rel] = {
        mtimeMs: info.mtimeMs,
        bytes: info.size,
        hash: await hashFile(abs),
        width: out.width,
        height: out.height,
      };
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
  // nothing new: the file keeps the settings it was made with (entries from another engine are still valid)
  const unchanged = previous !== null && generated === 0 && removed === 0 && !options.dryRun;
  const header = unchanged
    ? {
        engine: previous.engine ?? renderer.name,
        format: previous.format ?? renderer.format,
        quality: previous.quality ?? quality,
        accuracy: previous.accuracy,
      }
    : {
        engine: renderer.name,
        format: renderer.format,
        quality,
        accuracy: renderer.name === 'portable' ? (renderer.accuracy ?? 'fast') : undefined,
      };
  const output: PlaceholdersFile = {
    version: 1,
    generatedAt: unchanged ? previous.generatedAt : new Date().toISOString(),
    size,
    engine: header.engine,
    format: header.format,
    quality: header.quality,
    ...(header.accuracy ? { accuracy: header.accuracy } : {}),
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
      engine: canReuse && previous ? (previous.engine ?? renderer.name) : renderer.name,
      format: canReuse && previous ? (previous.format ?? renderer.format) : renderer.format,
      errors,
      unsupported,
    };
  }

  // Nothing changed: leave the file alone, so a committed placeholders.json does not churn.
  if (!unchanged) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
    options.log?.info(
      `placeholders (${header.engine}, ${header.format}): ${generated} generated, ${reused} reused, ${removed} removed → ${relative(projectDir, file)}`,
    );
  }
  return {
    generated,
    reused,
    removed,
    total: ordered.length,
    file,
    engine: header.engine,
    format: header.format,
    errors,
    unsupported,
  };
}

/** SHA-256 of a file, as the first 128 bits in base64url. */
async function hashFile(abs: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
  return hash.digest('base64url').slice(0, 22);
}

/**
 * Whether the entries of `previous` are valid for a run with `current` settings. Entries made by the same
 * engine need the same format, quality (WebP) and accuracy (portable). Entries made by another engine stay
 * valid unless this run pins the engine or the format: a CI image without sharp must not throw away the WebP
 * placeholders a developer machine generated, and `--check` there must agree with the file in git.
 */
function reusable(
  previous: PlaceholdersFile | null,
  current: {
    size: number;
    engine: PlaceholderEngineName;
    format: PlaceholderFormat;
    quality: number;
    accuracy: 'fast' | 'exact';
  },
  pinned: { engine: boolean; format: boolean },
): boolean {
  if (!previous || previous.size !== current.size) return false;
  if (previous.engine === current.engine) {
    if (previous.format !== current.format) return false;
    if (current.format === 'webp' && previous.quality !== current.quality) return false;
    if (current.engine === 'portable' && (previous.accuracy ?? 'fast') !== current.accuracy) return false;
    return true;
  }
  if (pinned.engine) return false;
  if (pinned.format && previous.format !== current.format) return false;
  return true;
}
