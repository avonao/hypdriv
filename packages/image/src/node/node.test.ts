import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generatePlaceholders,
  loadSharp,
  type PlaceholdersFile,
  readPlaceholdersFile,
  type SharpLike,
} from './index';

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
  it('returns sharp-missing without writing when sharp is unavailable', async () => {
    const warnings: string[] = [];
    const result = await generatePlaceholders({
      projectDir: dir,
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
    expect(result).toMatchObject({ generated: 2, reused: 0, removed: 0, total: 2, errors: [] });
    expect(result.file).toBe(join(dir, '.hypdriv', 'placeholders.json'));
    const file = JSON.parse(await readFile(result.file, 'utf8')) as PlaceholdersFile;
    expect(file.version).toBe(1);
    expect(file.size).toBe(12);
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
