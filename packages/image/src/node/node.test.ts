import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generatePlaceholders,
  loadSharp,
  loadWasmCodecs,
  type PlaceholdersFile,
  readPlaceholdersFile,
  type SharpLike,
  type WasmCodecs,
} from './index';
import { decodePng, probePng } from './png';
import { renderPortable } from './portable';
import { Downscaler } from './raster';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const NO_CODECS: WasmCodecs = { decodeWebp: null, decodeAvif: null, encodeWebp: null, problems: {} };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hypdriv-image-'));
  await mkdir(join(dir, 'public', 'img', 'nested'), { recursive: true });
  await mkdir(join(dir, 'public', 'node_modules'), { recursive: true });
  await mkdir(join(dir, 'public', '.cache'), { recursive: true });
  await writeFile(join(dir, 'public', 'hero.jpg'), 'jpeg-bytes-1');
  await writeFile(join(dir, 'public', 'img', 'nested', 'photo.PNG'), 'png-bytes');
  await writeFile(join(dir, 'public', 'logo.svg'), '<svg/>');
  await writeFile(join(dir, 'public', 'notes.txt'), 'nope');
  await writeFile(join(dir, 'public', 'node_modules', 'x.png'), 'ignored');
  await writeFile(join(dir, 'public', '.cache', 'y.png'), 'ignored');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Deterministic fake sharp: encodes the file contents so outputs are inspectable. */
function fakeSharp(calls: string[]): SharpLike {
  return (input) => {
    const path = String(input);
    calls.push(path);
    const instance = {
      async metadata() {
        return { width: 800, height: 400 };
      },
      resize() {
        return instance;
      },
      webp() {
        return instance;
      },
      async toBuffer() {
        return new TextEncoder().encode(`webp:${await readFile(path, 'utf8')}`);
      },
    };
    return instance;
  };
}

describe('generatePlaceholders', () => {
  it('returns sharp-missing without writing when sharp is required but unavailable', async () => {
    const warnings: string[] = [];
    const result = await generatePlaceholders({
      projectDir: dir,
      engine: 'sharp',
      sharp: null,
      log: { info() {}, warn: (m) => warnings.push(m) },
    });
    expect(result.skipped).toBe('sharp-missing');
    expect(result.generated).toBe(0);
    expect(result.message).toContain('pnpm add -D sharp');
    expect(warnings).toHaveLength(1);
    await expect(stat(join(dir, '.hypdriv', 'placeholders.json'))).rejects.toThrow();
  });

  it('walks sources, writes the map keyed by public path and skips ignored/unsupported files', async () => {
    const calls: string[] = [];
    const result = await generatePlaceholders({ projectDir: dir, sharp: fakeSharp(calls), size: 12 });
    expect(result).toMatchObject({
      generated: 2,
      reused: 0,
      removed: 0,
      total: 2,
      errors: [],
      unsupported: [],
      engine: 'sharp',
      format: 'webp',
    });
    expect(result.file).toBe(join(dir, '.hypdriv', 'placeholders.json'));
    const file = JSON.parse(await readFile(result.file, 'utf8')) as PlaceholdersFile;
    expect(file.version).toBe(1);
    expect(file.size).toBe(12);
    expect(file).toMatchObject({ engine: 'sharp', format: 'webp', quality: 40 });
    expect(Object.keys(file.placeholders)).toEqual(['/hero.jpg', '/img/nested/photo.PNG']);
    expect(file.placeholders['/hero.jpg']).toBe(
      `data:image/webp;base64,${Buffer.from('webp:jpeg-bytes-1').toString('base64')}`,
    );
    expect(file.meta['/hero.jpg']).toMatchObject({ width: 800, height: 400, bytes: 12 });
    expect(calls.some((c) => c.includes('node_modules'))).toBe(false);
    expect(calls.some((c) => c.includes('.cache'))).toBe(false);
  });

  it('is incremental: reuses unchanged entries, regenerates changed ones, drops removed ones', async () => {
    const first = await generatePlaceholders({ projectDir: dir, sharp: fakeSharp([]) });
    expect(first.generated).toBe(2);
    const calls: string[] = [];
    const second = await generatePlaceholders({ projectDir: dir, sharp: fakeSharp(calls) });
    expect(second).toMatchObject({ generated: 0, reused: 2, removed: 0, total: 2 });
    expect(calls).toEqual([]);

    // change hero.jpg (size + mtime), add one, remove one
    await writeFile(join(dir, 'public', 'hero.jpg'), 'jpeg-bytes-2!!');
    await utimes(join(dir, 'public', 'hero.jpg'), new Date(), new Date(Date.now() + 5000));
    await writeFile(join(dir, 'public', 'new.webp'), 'webp-bytes');
    await rm(join(dir, 'public', 'img', 'nested', 'photo.PNG'));
    const third = await generatePlaceholders({ projectDir: dir, sharp: fakeSharp(calls) });
    expect(third).toMatchObject({ generated: 2, reused: 0, removed: 1, total: 2 });
    const file = (await readPlaceholdersFile(third.file))!;
    expect(Object.keys(file.placeholders)).toEqual(['/hero.jpg', '/new.webp']);
    expect(file.placeholders['/hero.jpg']).toContain(Buffer.from('webp:jpeg-bytes-2!!').toString('base64'));

    // a different size invalidates everything
    const resized = await generatePlaceholders({ projectDir: dir, sharp: fakeSharp([]), size: 24 });
    expect(resized).toMatchObject({ generated: 2, reused: 0 });
  });

  it('supports several sources, custom output files and reports encode errors', async () => {
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'assets', 'extra.avif'), 'avif');
    await writeFile(join(dir, 'assets', 'broken.gif'), 'gif');
    const throwing: SharpLike = (input) => {
      const inner = fakeSharp([])(input);
      if (String(input).endsWith('broken.gif')) {
        return {
          ...inner,
          metadata: async () => {
            throw new Error('corrupt header');
          },
        };
      }
      return inner;
    };
    const result = await generatePlaceholders({
      projectDir: dir,
      sources: ['public', 'assets'],
      sharp: throwing,
      file: 'out/placeholders.json',
      concurrency: 1,
    });
    expect(result.total).toBe(3);
    expect(result.errors).toEqual([{ path: '/broken.gif', error: 'corrupt header' }]);
    const file = (await readPlaceholdersFile(join(dir, 'out', 'placeholders.json')))!;
    expect(Object.keys(file.placeholders)).toEqual(['/extra.avif', '/hero.jpg', '/img/nested/photo.PNG']);
  });

  it('reports no-sources when nothing matches and there is no previous file', async () => {
    const result = await generatePlaceholders({
      projectDir: dir,
      sources: ['missing-dir'],
      sharp: fakeSharp([]),
    });
    expect(result.skipped).toBe('no-sources');
    expect(await readPlaceholdersFile(join(dir, '.hypdriv', 'placeholders.json'))).toBeNull();
  });

  it('encodes real images when sharp is installed', async () => {
    const sharp = await loadSharp();
    if (!sharp) return; // optional peer not installed in this environment: the sharp-missing branch is covered above
    // Let sharp itself produce a valid 2x2 PNG so the fixture never depends on hand-written bytes.
    const create = sharp as unknown as (options: object) => { png(): { toBuffer(): Promise<Uint8Array> } };
    const png = await create({
      create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    await writeFile(join(dir, 'public', 'hero.jpg'), png);
    await rm(join(dir, 'public', 'img'), { recursive: true });
    const result = await generatePlaceholders({ projectDir: dir, size: 8 });
    expect(result.skipped).toBeUndefined();
    expect(result.generated).toBe(1);
    const file = (await readPlaceholdersFile(result.file))!;
    expect(file.placeholders['/hero.jpg']).toMatch(/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
    expect(file.meta['/hero.jpg']).toMatchObject({ width: 2, height: 2 });
  });
});

describe('generatePlaceholders without sharp (portable engine)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hypdriv-portable-'));
    await mkdir(join(root, 'public', 'img'), { recursive: true });
    await copyFile(join(fixtures, 'jpeg-420-baseline.jpg'), join(root, 'public', 'hero.jpg'));
    await copyFile(join(fixtures, 'png-rgba8.png'), join(root, 'public', 'img', 'logo.png'));
    await copyFile(join(fixtures, 'gif-transparent.gif'), join(root, 'public', 'img', 'anim.gif'));
    // the extension lies: the bytes decide
    await copyFile(join(fixtures, 'jpeg-gray.jpg'), join(root, 'public', 'img', 'looks-like-png.PNG'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('falls back to the portable engine when sharp is missing and writes PNG placeholders', async () => {
    const info: string[] = [];
    const result = await generatePlaceholders({
      projectDir: root,
      sharp: null,
      wasm: null,
      log: { info: (m) => info.push(m), warn() {} },
    });
    expect(result.skipped).toBeUndefined();
    expect(result).toMatchObject({
      generated: 4,
      total: 4,
      errors: [],
      unsupported: [],
      engine: 'portable',
      format: 'png',
    });
    expect(info.at(-1)).toContain('portable, png');

    const file = (await readPlaceholdersFile(result.file))!;
    expect(file).toMatchObject({ engine: 'portable', format: 'png', quality: 40, size: 16 });
    expect(Object.keys(file.placeholders)).toEqual([
      '/hero.jpg',
      '/img/anim.gif',
      '/img/logo.png',
      '/img/looks-like-png.PNG',
    ]);
    expect(file.meta['/hero.jpg']).toMatchObject({ width: 320, height: 200 });
    expect(file.meta['/img/logo.png']).toMatchObject({ width: 96, height: 60 });

    for (const [key, url] of Object.entries(file.placeholders)) {
      expect(url, key).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
      const png = Buffer.from(url.split(',')[1]!, 'base64');
      expect(png.length, key).toBeLessThan(900);
      expect(probePng(png).width, key).toBe(16);
    }
    // the logo has an alpha ramp, so its placeholder is an RGBA PNG; the opaque JPEG's is RGB
    expect(
      probePng(Buffer.from(file.placeholders['/img/logo.png']!.split(',')[1]!, 'base64')).colorType,
    ).toBe(6);
    expect(probePng(Buffer.from(file.placeholders['/hero.jpg']!.split(',')[1]!, 'base64')).colorType).toBe(2);
    // and it decodes back to the picture's colours: the JPEG's top-left corner is dark red/green → gradient start
    const scaler = new Downscaler(16, 10);
    await decodePng(Buffer.from(file.placeholders['/hero.jpg']!.split(',')[1]!, 'base64'), scaler);
    const pixels = scaler.finish().data;
    expect(pixels[0]!).toBeLessThan(pixels[15 * 4]!); // red channel rises left to right
  });

  it('is the default engine order: sharp first, portable otherwise', async () => {
    const withSharp = await generatePlaceholders({
      projectDir: root,
      sharp: fakeSharp([]),
      wasm: null,
      sources: ['public/img'],
    });
    expect(withSharp.engine).toBe('sharp');
    const portable = await generatePlaceholders({
      projectDir: root,
      engine: 'portable',
      sharp: fakeSharp([]), // present but not wanted
      wasm: null,
      sources: ['public/img'],
    });
    expect(portable.engine).toBe('portable');
    expect(portable.generated).toBe(3); // engine change invalidates the cache
    expect(portable.reused).toBe(0);
  });

  it('plans without decoding or writing when dryRun is set', async () => {
    const base = { projectDir: root, sharp: null, wasm: null } as const;
    const fresh = await generatePlaceholders({ ...base, dryRun: true });
    expect(fresh).toMatchObject({ generated: 4, reused: 0, removed: 0, total: 4, engine: 'portable' });
    await expect(stat(join(root, '.hypdriv', 'placeholders.json'))).rejects.toThrow();

    await generatePlaceholders(base);
    expect(await generatePlaceholders({ ...base, dryRun: true })).toMatchObject({
      generated: 0,
      reused: 4,
      removed: 0,
    });
    await rm(join(root, 'public', 'img', 'logo.png'));
    await copyFile(join(fixtures, 'png-rgb8.png'), join(root, 'public', 'new.png'));
    expect(await generatePlaceholders({ ...base, dryRun: true })).toMatchObject({
      generated: 1,
      reused: 3,
      removed: 1,
      total: 4,
    });
    // and nothing was written by the dry runs
    expect(
      Object.keys((await readPlaceholdersFile(join(root, '.hypdriv', 'placeholders.json')))!.placeholders),
    ).toContain('/img/logo.png');
  });

  it('reuses entries only while the settings that shape them are unchanged', async () => {
    const base = { projectDir: root, sharp: null, wasm: null } as const;
    expect((await generatePlaceholders(base)).generated).toBe(4);
    expect(await generatePlaceholders(base)).toMatchObject({ generated: 0, reused: 4 });
    // a PNG does not depend on the WebP quality
    expect(await generatePlaceholders({ ...base, quality: 80 })).toMatchObject({ generated: 0, reused: 4 });
    // the size does, and so does how big JPEGs are decoded
    expect((await generatePlaceholders({ ...base, size: 24 })).generated).toBe(4);
    expect(await generatePlaceholders({ ...base, size: 24 })).toMatchObject({ generated: 0, reused: 4 });
    const exact = await generatePlaceholders({ ...base, size: 24, accuracy: 'exact' });
    expect(exact.generated).toBe(4);
    expect((await readPlaceholdersFile(exact.file))!.accuracy).toBe('exact');
    expect(await generatePlaceholders({ ...base, size: 24, accuracy: 'exact' })).toMatchObject({ reused: 4 });
    expect((await generatePlaceholders({ ...base, size: 24 })).generated).toBe(4); // back to fast
  });

  it('regenerates WebP entries when the quality changes', async () => {
    const encodeWebp = async (_image: unknown, quality: number) => new TextEncoder().encode(`q${quality}`);
    const base = { projectDir: root, sharp: null, wasm: { ...NO_CODECS, encodeWebp } } as const;
    const first = await generatePlaceholders({ ...base, quality: 55 });
    expect(first).toMatchObject({ generated: 4, format: 'webp' });
    expect(await generatePlaceholders({ ...base, quality: 55 })).toMatchObject({ generated: 0, reused: 4 });
    expect((await generatePlaceholders({ ...base, quality: 80 })).generated).toBe(4);
  });

  it('keeps entries another engine made unless this run pins the engine or the format', async () => {
    const calls: string[] = [];
    const sharp = await generatePlaceholders({ projectDir: root, sharp: fakeSharp(calls), wasm: null });
    expect(sharp).toMatchObject({ engine: 'sharp', format: 'webp', generated: 4 });
    const before = await readFile(sharp.file, 'utf8');

    // CI without sharp (engine auto): the committed file is still right, --check agrees, nothing is rewritten
    const ci = { projectDir: root, sharp: null, wasm: null } as const;
    expect(await generatePlaceholders({ ...ci, dryRun: true })).toMatchObject({
      generated: 0,
      reused: 4,
      removed: 0,
      engine: 'sharp',
      format: 'webp',
    });
    expect(await generatePlaceholders(ci)).toMatchObject({ generated: 0, reused: 4, engine: 'sharp' });
    expect(await readFile(sharp.file, 'utf8')).toBe(before);

    // pinning the engine or the format asks for different pictures
    expect((await generatePlaceholders({ ...ci, engine: 'portable' })).generated).toBe(4);
    expect((await generatePlaceholders({ ...ci, engine: 'portable', format: 'png' })).reused).toBe(4);
    const pinnedFormat = await generatePlaceholders({
      projectDir: root,
      sharp: fakeSharp(calls),
      wasm: null,
      format: 'webp',
    });
    expect(pinnedFormat).toMatchObject({ engine: 'sharp', generated: 4 }); // the PNG entries are replaced
  });

  it('recognises unchanged pictures by content after a checkout resets every mtime', async () => {
    const base = { projectDir: root, sharp: null, wasm: null } as const;
    const first = await generatePlaceholders(base);
    const written = await readFile(first.file, 'utf8');
    const later = new Date(Date.now() + 3_600_000);
    for (const rel of ['hero.jpg', 'img/logo.png', 'img/anim.gif', 'img/looks-like-png.PNG']) {
      await utimes(join(root, 'public', rel), later, later);
    }
    expect(await generatePlaceholders({ ...base, dryRun: true })).toMatchObject({ generated: 0, reused: 4 });
    expect(await generatePlaceholders(base)).toMatchObject({ generated: 0, reused: 4 });
    expect(await readFile(first.file, 'utf8')).toBe(written); // not rewritten: no churn in git

    // same size, other bytes: regenerated even though nothing but the content moved
    const logo = join(root, 'public', 'img', 'logo.png');
    const bytes = await readFile(logo);
    bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 0xff;
    await writeFile(logo, bytes);
    await utimes(logo, later, later);
    expect(await generatePlaceholders({ ...base, dryRun: true })).toMatchObject({ generated: 1, reused: 3 });
  });

  it('does not rewrite the file or its timestamp when nothing changed', async () => {
    const base = { projectDir: root, sharp: null, wasm: null } as const;
    const first = await generatePlaceholders(base);
    const written = JSON.parse(await readFile(first.file, 'utf8')) as PlaceholdersFile;
    await new Promise((r) => setTimeout(r, 15));
    await generatePlaceholders(base);
    expect((JSON.parse(await readFile(first.file, 'utf8')) as PlaceholdersFile).generatedAt).toBe(
      written.generatedAt,
    );
    // a real change does rewrite it
    await rm(join(root, 'public', 'img', 'anim.gif'));
    const removed = await generatePlaceholders(base);
    expect(removed.removed).toBe(1);
    expect((JSON.parse(await readFile(first.file, 'utf8')) as PlaceholdersFile).generatedAt).not.toBe(
      written.generatedAt,
    );
  });

  it('reports WebP and AVIF as unsupported (not errors) when no codec is installed, and keeps the rest', async () => {
    await copyFile(join(fixtures, 'webp-lossy.webp'), join(root, 'public', 'photo.webp'));
    await copyFile(join(fixtures, 'avif-lossy.avif'), join(root, 'public', 'photo.avif'));
    await writeFile(join(root, 'public', 'broken.png'), 'definitely not an image');
    const warnings: string[] = [];
    const result = await generatePlaceholders({
      projectDir: root,
      sharp: null,
      wasm: NO_CODECS,
      log: { info() {}, warn: (m) => warnings.push(m) },
    });
    expect(result.generated).toBe(4);
    expect(result.unsupported.map((u) => u.path)).toEqual(['/photo.avif', '/photo.webp']);
    expect(result.unsupported[0]!.reason).toContain('@jsquash/avif');
    expect(result.errors).toEqual([
      { path: '/broken.png', error: expect.stringContaining('not a PNG, JPEG, GIF') },
    ]);
    expect(warnings.join('\n')).toMatch(/2 image\(s\) have no placeholder/);
  });

  it('does not count pictures no codec reads as out of date in a dry run', async () => {
    await copyFile(join(fixtures, 'webp-lossy.webp'), join(root, 'public', 'photo.webp'));
    await copyFile(join(fixtures, 'avif-lossy.avif'), join(root, 'public', 'photo.avif'));
    const base = { projectDir: root, sharp: null, wasm: NO_CODECS } as const;

    const planned = await generatePlaceholders({ ...base, dryRun: true });
    expect(planned).toMatchObject({ generated: 4, total: 4, errors: [] });
    expect(planned.unsupported.map((u) => u.path)).toEqual(['/photo.avif', '/photo.webp']);

    await generatePlaceholders(base);
    const fresh = await generatePlaceholders({ ...base, dryRun: true });
    expect(fresh).toMatchObject({ generated: 0, reused: 4, removed: 0 });
    expect(fresh.unsupported).toHaveLength(2);

    // installing a decoder turns the same picture into work again
    const decodeWebp = async () => ({ width: 1, height: 1, data: new Uint8Array(4) });
    const withCodec = await generatePlaceholders({
      ...base,
      wasm: { ...NO_CODECS, decodeWebp },
      dryRun: true,
    });
    expect(withCodec).toMatchObject({ generated: 1, reused: 4 });
    expect(withCodec.unsupported.map((u) => u.path)).toEqual(['/photo.avif']);
  });

  it('uses WebAssembly codecs when they are available: WebP output, WebP and AVIF sources', async () => {
    await copyFile(join(fixtures, 'webp-lossy.webp'), join(root, 'public', 'photo.webp'));
    const codecs: WasmCodecs = {
      ...NO_CODECS,
      decodeWebp: async () => ({ width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4).fill(180) }),
      encodeWebp: async (image, quality) =>
        new TextEncoder().encode(`webp:${image.width}x${image.height}:q${quality}`),
    };
    const result = await generatePlaceholders({ projectDir: root, sharp: null, wasm: codecs, quality: 55 });
    expect(result).toMatchObject({ generated: 5, engine: 'portable', format: 'webp', unsupported: [] });
    const file = (await readPlaceholdersFile(result.file))!;
    expect(file.placeholders['/photo.webp']).toBe(
      `data:image/webp;base64,${Buffer.from('webp:16x8:q55').toString('base64')}`,
    );
    expect(file.meta['/photo.webp']).toMatchObject({ width: 40, height: 20 });
    expect(file.placeholders['/hero.jpg']).toContain(Buffer.from('webp:16x10:q55').toString('base64'));
  });

  it('honours format: png even when a WebP encoder exists, and skips when webp is forced without one', async () => {
    const encode = async () => new Uint8Array([1, 2, 3]);
    const png = await generatePlaceholders({
      projectDir: root,
      sharp: null,
      wasm: { ...NO_CODECS, encodeWebp: encode },
      format: 'png',
    });
    expect(png.format).toBe('png');
    const warnings: string[] = [];
    const forced = await generatePlaceholders({
      projectDir: root,
      sharp: null,
      wasm: NO_CODECS,
      format: 'webp',
      file: 'forced.json',
      log: { info() {}, warn: (m) => warnings.push(m) },
    });
    expect(forced.skipped).toBe('engine-missing');
    expect(forced.message).toContain('@jsquash/webp');
    expect(warnings).toHaveLength(1);
    await expect(stat(join(root, 'forced.json'))).rejects.toThrow();
  });

  it('warns about codecs that resolved but failed to load, and carries on without them', async () => {
    const warnings: string[] = [];
    const result = await generatePlaceholders({
      projectDir: root,
      sharp: null,
      wasm: { ...NO_CODECS, problems: { '@jsquash/webp': 'wasm exploded' } },
      log: { info() {}, warn: (m) => warnings.push(m) },
    });
    expect(result.generated).toBe(4);
    expect(warnings[0]).toContain('@jsquash/webp could not be loaded (wasm exploded)');
  });

  it('enforces the pixel budget per image and supports the exact JPEG mode', async () => {
    const budget = await generatePlaceholders({
      projectDir: root,
      sharp: null,
      wasm: null,
      maxPixels: 10_000,
      file: 'a.json',
    });
    expect(budget.errors.map((e) => e.path)).toEqual(['/hero.jpg', '/img/looks-like-png.PNG']);
    expect(budget.errors[0]!.error).toMatch(/above the limit of 10000/);
    const exact = await generatePlaceholders({
      projectDir: root,
      sharp: null,
      wasm: null,
      accuracy: 'exact',
      file: 'b.json',
    });
    expect(exact).toMatchObject({ generated: 4, errors: [] });
    const fast = await generatePlaceholders({ projectDir: root, sharp: null, wasm: null, file: 'c.json' });
    const a = (await readPlaceholdersFile(exact.file))!.placeholders['/hero.jpg'];
    const b = (await readPlaceholdersFile(fast.file))!.placeholders['/hero.jpg'];
    expect(a).toMatch(/^data:image\/png/);
    expect(b).toMatch(/^data:image\/png/);
  });

  it('matches what sharp produces when sharp is installed', async () => {
    const sharp = await loadSharp();
    if (!sharp) return; // optional peer: the comparison needs the real thing
    const options = { projectDir: root, sources: ['public/img'] };
    const viaSharp = await generatePlaceholders({ ...options, sharp, format: 'png', file: 'sharp.json' });
    const viaPortable = await generatePlaceholders({
      ...options,
      engine: 'portable',
      wasm: null,
      file: 'portable.json',
    });
    expect(viaSharp.engine).toBe('sharp');
    const a = (await readPlaceholdersFile(viaSharp.file))!;
    const b = (await readPlaceholdersFile(viaPortable.file))!;
    expect(Object.keys(b.placeholders)).toEqual(Object.keys(a.placeholders));
    for (const key of Object.keys(b.placeholders)) {
      const left = pixelsOf(a.placeholders[key]!);
      const right = pixelsOf(b.placeholders[key]!);
      expect(right.width, key).toBe(left.width);
      expect(Math.abs(right.height - left.height), key).toBeLessThanOrEqual(1);
      if (right.height !== left.height) continue;
      let sum = 0;
      for (let i = 0; i < left.data.length; i++) sum += Math.abs(left.data[i]! - right.data[i]!);
      // sharp resamples with Lanczos, the portable engine averages areas: same picture, slightly different edges
      expect(sum / left.data.length, key).toBeLessThan(14);
    }
  });
});

/** Decodes a placeholder `data:` URL (PNG) to raw RGBA. */
function pixelsOf(dataUrl: string): { width: number; height: number; data: Uint8Array } {
  const bytes = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  const { width, height } = probePng(bytes);
  const data = new Uint8Array(width * height * 4);
  decodePng(bytes, {
    begin() {},
    push(y, row) {
      data.set(row, y * width * 4);
    },
  });
  return { width, height, data };
}

describe('@jsquash WebAssembly codecs', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hypdriv-wasm-'));
    await mkdir(join(root, 'public'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loads from the project or from Hypdriv and reports nothing for a missing package', async () => {
    const codecs = await loadWasmCodecs(root);
    expect(codecs.problems).toEqual({});
    // the repository installs both as devDependencies, so they resolve through @hypdriv/image
    expect(codecs.decodeWebp).toBeTypeOf('function');
    expect(codecs.decodeAvif).toBeTypeOf('function');
    expect(codecs.encodeWebp).toBeTypeOf('function');
  });

  it('decodes real WebP and AVIF files like libwebp / libavif', async () => {
    const codecs = await loadWasmCodecs(root);
    const webp = await codecs.decodeWebp!(new Uint8Array(await readFile(join(fixtures, 'webp-lossy.webp'))));
    expect([webp.width, webp.height]).toEqual([160, 100]);
    expect(webp.data).toHaveLength(160 * 100 * 4);
    const avif = await codecs.decodeAvif!(new Uint8Array(await readFile(join(fixtures, 'avif-lossy.avif'))));
    expect([avif.width, avif.height]).toEqual([128, 80]);
    await expect(codecs.decodeWebp!(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });

  it('renders every WebP and AVIF flavour like the reference decoders, animations by their first frame', async () => {
    const codecs = await loadWasmCodecs(root);
    const references = JSON.parse(await readFile(join(fixtures, 'reference.json'), 'utf8')) as Record<
      string,
      Record<string, { width: number; height: number; target: [number, number]; rgba: string }>
    >;
    for (const file of [
      'webp-lossy.webp',
      'webp-lossless.webp',
      'webp-lossy-alpha.webp',
      'webp-lossless-alpha.webp',
      'webp-animated.webp',
      'avif-lossy.avif',
    ]) {
      const reference = references[file]!['16']!;
      const out = await renderPortable(new Uint8Array(await readFile(join(fixtures, file))), {
        size: 16,
        codecs,
      });
      expect([out.width, out.height], file).toEqual([reference.width, reference.height]);
      expect([out.bitmap.width, out.bitmap.height], file).toEqual(reference.target);
      const expected = Buffer.from(reference.rgba, 'base64');
      let worst = 0;
      for (let i = 0; i < expected.length; i++) {
        worst = Math.max(worst, Math.abs(out.bitmap.data[i]! - expected[i]!));
      }
      expect(worst, file).toBeLessThanOrEqual(2);
    }
  });

  it('refuses a WebP or AVIF by its header limits before the codec allocates anything', async () => {
    const codecs = await loadWasmCodecs(root);
    for (const file of ['webp-lossy.webp', 'avif-lossy.avif']) {
      const bytes = new Uint8Array(await readFile(join(fixtures, file)));
      await expect(renderPortable(bytes, { size: 16, maxPixels: 100, codecs })).rejects.toThrow(
        /above the limit/,
      );
    }
  });

  it('generates WebP placeholders from JPEG, PNG, GIF, WebP and AVIF without any native module', async () => {
    for (const [from, to] of [
      ['jpeg-420-baseline.jpg', 'a.jpg'],
      ['png-rgba8.png', 'b.png'],
      ['gif-static.gif', 'c.gif'],
      ['webp-lossy.webp', 'd.webp'],
      ['webp-lossless-alpha.webp', 'e.webp'],
      ['avif-lossy.avif', 'f.avif'],
    ] as const) {
      await copyFile(join(fixtures, from), join(root, 'public', to));
    }
    const result = await generatePlaceholders({ projectDir: root, engine: 'portable', quality: 60 });
    expect(result).toMatchObject({
      generated: 6,
      errors: [],
      unsupported: [],
      engine: 'portable',
      format: 'webp',
    });
    const file = (await readPlaceholdersFile(result.file))!;
    expect(file.meta['/f.avif']).toMatchObject({ width: 128, height: 80 });
    expect(file.meta['/e.webp']).toMatchObject({ width: 96, height: 60 });
    const codecs = await loadWasmCodecs(root);
    for (const [key, url] of Object.entries(file.placeholders)) {
      expect(url, key).toMatch(/^data:image\/webp;base64,/);
      const bytes = Buffer.from(url.split(',')[1]!, 'base64');
      expect(bytes.length, key).toBeLessThan(400);
      const decoded = await codecs.decodeWebp!(bytes);
      expect(decoded.width, key).toBe(16);
    }
    // a decoded placeholder is the picture, only smaller: the red ramp of the source scene survives
    const hero = await codecs.decodeWebp!(Buffer.from(file.placeholders['/a.jpg']!.split(',')[1]!, 'base64'));
    expect(hero.data[0]!).toBeLessThan(hero.data[(hero.width - 1) * 4]!);
  });

  it("encodes WebP without jSquash's encode.js (wasm-feature-detect 1.10 does not parse before Node 24)", async () => {
    // the project's own @jsquash/webp: a copy of the real one whose encode.js cannot be loaded, the way
    // `import.source(…)` in wasm-feature-detect 1.10 breaks it on Node 20 and 22
    const real = dirname(createRequire(import.meta.url).resolve('@jsquash/webp/package.json'));
    const copy = join(root, 'node_modules', '@jsquash', 'webp');
    await cp(real, copy, { recursive: true, dereference: true });
    await writeFile(join(copy, 'encode.js'), 'throw new SyntaxError("Unexpected identifier \'source\'");\n');
    const codecs = await loadWasmCodecs(root);
    expect(codecs.problems).toEqual({});
    const image = { data: new Uint8ClampedArray(8 * 8 * 4).fill(200), width: 8, height: 8 };
    const webp = await codecs.encodeWebp!(image, 50);
    expect(Buffer.from(webp.subarray(0, 4)).toString('latin1')).toBe('RIFF');
    expect(Buffer.from(webp.subarray(8, 12)).toString('latin1')).toBe('WEBP');
    const decoded = await codecs.decodeWebp!(webp);
    expect([decoded.width, decoded.height]).toEqual([8, 8]);
    // every call returns its own bytes, never a view of WebAssembly memory that the next call overwrites
    const second = await codecs.encodeWebp!(
      { ...image, data: new Uint8ClampedArray(8 * 8 * 4).fill(10) },
      50,
    );
    expect(Buffer.compare(Buffer.from(webp), Buffer.from(second))).not.toBe(0);
    expect(webp.byteLength).toBe(webp.buffer.byteLength);
  });

  it('reports why the encoder is unavailable when the WebAssembly module does not load', async () => {
    const real = dirname(createRequire(import.meta.url).resolve('@jsquash/webp/package.json'));
    const copy = join(root, 'node_modules', '@jsquash', 'webp');
    await cp(real, copy, { recursive: true, dereference: true });
    for (const variant of ['webp_enc_simd.wasm', 'webp_enc.wasm']) {
      await writeFile(
        join(copy, 'codec', 'enc', variant),
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 255]),
      );
    }
    const codecs = await loadWasmCodecs(root);
    expect(codecs.encodeWebp).toBeNull();
    expect(codecs.problems['@jsquash/webp (encoder)']).toMatch(/\S/);
    // the decoder has its own module and still works
    expect(codecs.decodeWebp).toBeTypeOf('function');
  });
});
