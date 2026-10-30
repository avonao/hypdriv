import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

/** Shape of `.hypdriv/placeholders.json`. */
export interface PlaceholdersFile {
  version: 1;
  generatedAt: string;
  /** Placeholder width in pixels. */
  size: number;
  /** `/`-prefixed public path → `data:image/webp;base64,…`. */
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
  /** Injected `sharp` module (tests); default: dynamic `import('sharp')`. */
  sharp?: SharpLike | null;
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
  skipped?: 'sharp-missing' | 'no-sources';
  message?: string;
  /** Files that failed to encode, with the error message. */
  errors: Array<{ path: string; error: string }>;
}

/** Minimal structural type of the `sharp` module HypDriv uses. */
export type SharpLike = (input: string | Buffer) => SharpInstanceLike;
export interface SharpInstanceLike {
  metadata(): Promise<{ width?: number; height?: number }>;
  resize(width: number, height?: number | null, options?: Record<string, unknown>): SharpInstanceLike;
  webp(options?: { quality?: number }): SharpInstanceLike;
  toBuffer(): Promise<Uint8Array>;
}

const DEFAULT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif'];

/** Tries to load `sharp`; `null` when it is not installed. */
export async function loadSharp(): Promise<SharpLike | null> {
  const specifier = 'sharp';
  try {
    const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ specifier)) as { default?: unknown } | undefined;
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

/**
 * Generates tiny blurred WebP placeholders for raster images under the source directories and writes
 * them to `.hypdriv/placeholders.json`, keyed by `/`-prefixed public path (`public/hero.jpg` → `/hero.jpg`).
 *
 * Incremental: sources whose size and mtime match the previous run are reused; vanished sources are
 * removed. `sharp` is an optional peer loaded dynamically; when it is missing the function returns
 * `{ generated: 0, skipped: 'sharp-missing' }` with an install hint instead of throwing.
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

  const sharp = options.sharp === undefined ? await loadSharp() : options.sharp;
  if (!sharp) {
    const message =
      'sharp is not installed; image placeholders were skipped. Run `pnpm add -D sharp` (optional peer of @hypdriv/image) to generate `.hypdriv/placeholders.json`.';
    options.log?.warn(message);
    return { generated: 0, reused: 0, removed: 0, total: 0, file, skipped: 'sharp-missing', message, errors };
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
  const samePreset = previous !== null && previous.size === size;
  const placeholders: Record<string, string> = {};
  const meta: Record<string, PlaceholderMeta> = {};
  let generated = 0;
  let reused = 0;

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
    try {
      const image = sharp(abs);
      const dims = await image.metadata();
      const width = dims.width ?? 0;
      const height = dims.height ?? 0;
      const buffer = await sharp(abs)
        .resize(size, null, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
      placeholders[rel] = `data:image/webp;base64,${Buffer.from(buffer).toString('base64')}`;
      meta[rel] = { mtimeMs: info.mtimeMs, bytes: info.size, width, height };
      generated++;
    } catch (err) {
      errors.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const removed = previous
    ? Object.keys(previous.placeholders).filter((key) => !(key in placeholders)).length
    : 0;
  const ordered = Object.keys(placeholders).sort();
  const output: PlaceholdersFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    size,
    placeholders: Object.fromEntries(ordered.map((k) => [k, placeholders[k]!])),
    meta: Object.fromEntries(ordered.map((k) => [k, meta[k]!])),
  };

  if (found.size === 0 && !previous) {
    return { generated: 0, reused: 0, removed: 0, total: 0, file, skipped: 'no-sources', errors };
  }

  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  options.log?.info(
    `placeholders: ${generated} generated, ${reused} reused, ${removed} removed → ${relative(projectDir, file)}`,
  );
  return { generated, reused, removed, total: ordered.length, file, errors };
}
