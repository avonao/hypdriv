import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupProjects, memoryIO, type TempProject, tempProject } from '../__tests__/helpers';
import { runCommand } from '../main';

const fixtures = fileURLToPath(new URL('../../../image/src/node/__fixtures__/', import.meta.url));
afterAll(cleanupProjects);

let project: TempProject;
beforeEach(() => {
  project = tempProject({
    'package.json': JSON.stringify({ name: 'shop' }),
    'hypdriv.config.ts':
      'export default { images: { placeholders: { engine: "portable", format: "png" } } };\n',
  });
  mkdirSync(join(project.dir, 'public', 'img'), { recursive: true });
  copyFileSync(join(fixtures, 'jpeg-420-baseline.jpg'), join(project.dir, 'public', 'hero.jpg'));
  copyFileSync(join(fixtures, 'png-rgba8.png'), join(project.dir, 'public', 'img', 'logo.png'));
  copyFileSync(join(fixtures, 'gif-static.gif'), join(project.dir, 'public', 'img', 'spinner.gif'));
});

async function run(args: string[]) {
  const io = memoryIO(project.dir);
  const code = await runCommand('placeholders', args, io);
  return { code, io, out: io.out };
}

describe('hypdriv placeholders', () => {
  it('generates the file with the engine and format from the configuration', async () => {
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toContain('3 generated, 0 reused, 0 removed → .hypdriv/placeholders.json (portable, png)');
    const file = JSON.parse(project.read('.hypdriv/placeholders.json'));
    expect(Object.keys(file.placeholders)).toEqual(['/hero.jpg', '/img/logo.png', '/img/spinner.gif']);
    expect(file).toMatchObject({ engine: 'portable', format: 'png', size: 16, quality: 40 });
    expect(file.placeholders['/hero.jpg']).toMatch(/^data:image\/png;base64,/);
    expect(file.meta['/hero.jpg']).toMatchObject({ width: 320, height: 200 });

    const again = await run([]);
    expect(again.out).toContain('0 generated, 3 reused');
  });

  it('reports machine-readable results with --json', async () => {
    const { code, io } = await run(['--json']);
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({
      command: 'placeholders',
      ok: true,
      mode: 'generate',
      engine: 'portable',
      format: 'png',
      generated: 3,
      reused: 0,
      removed: 0,
      total: 3,
      file: '.hypdriv/placeholders.json',
      skipped: null,
      errors: [],
      unsupported: [],
    });
  });

  it('--check writes nothing and fails while the file is missing or stale', async () => {
    const missing = await run(['--check']);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('is out of date: 3 to generate, 0 to remove');
    expect(existsSync(join(project.dir, '.hypdriv', 'placeholders.json'))).toBe(false);

    await run([]);
    const fresh = await run(['--check', '--json']);
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.io.out)).toMatchObject({ ok: true, mode: 'check', generated: 0, reused: 3 });

    copyFileSync(join(fixtures, 'png-rgb8.png'), join(project.dir, 'public', 'new.png'));
    const stale = await run(['--check']);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('1 to generate');
    // still nothing written by the check
    expect(Object.keys(JSON.parse(project.read('.hypdriv/placeholders.json')).placeholders)).toHaveLength(3);
  });

  it('reads WebP through the optional codec and fails on files that are not images', async () => {
    copyFileSync(join(fixtures, 'webp-lossy.webp'), join(project.dir, 'public', 'photo.webp'));
    const webp = await run(['--json', '--engine', 'portable']);
    // @jsquash/webp is a devDependency of @hypdriv/image, so the portable engine can decode (and encode) WebP
    expect(JSON.parse(webp.io.out)).toMatchObject({ ok: true, generated: 4, errors: [], unsupported: [] });

    writeFileSync(join(project.dir, 'public', 'broken.png'), 'not an image');
    const broken = await run([]);
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('/broken.png');
    expect(broken.out).toContain('not a PNG, JPEG, GIF, WebP or AVIF image');
    expect(JSON.parse((await run(['--json'])).io.out)).toMatchObject({ ok: false });
  });

  it('takes sources, size, quality and output file from flags', async () => {
    const { code, out } = await run([
      '--source',
      'public/img',
      '--size',
      '8',
      '--file',
      'out/p.json',
      '--quality',
      '60',
    ]);
    expect(code).toBe(0);
    expect(out).toContain('→ out/p.json');
    const file = JSON.parse(project.read('out/p.json'));
    expect(Object.keys(file.placeholders)).toEqual(['/logo.png', '/spinner.gif']);
    expect(file).toMatchObject({ size: 8, quality: 60 });
  });

  it('rejects invalid values and a disabled feature', async () => {
    const bad = await run(['--engine', 'wasm']);
    expect(bad.code).not.toBe(0);
    expect(bad.io.err + bad.io.out).toContain('--engine must be one of: auto, sharp, portable');
    expect((await run(['--size', '2'])).code).not.toBe(0);

    project.write('hypdriv.config.ts', 'export default { images: { placeholders: { enabled: false } } };\n');
    const disabled = await run([]);
    expect(disabled.code).toBe(1);
    expect(disabled.io.err + disabled.io.out).toContain('disabled in hypdriv.config');
  });

  it('says so when there is nothing to do', async () => {
    const { code, out } = await run(['--source', 'nowhere']);
    expect(code).toBe(0);
    expect(out).toContain('no raster images found under nowhere');
    expect(readFileSync(join(project.dir, 'package.json'), 'utf8')).toContain('shop');
  });
});
