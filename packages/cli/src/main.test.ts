import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, memoryIO, openNextProject, tempProject } from './__tests__/helpers';
import { createMemoryIO } from './io';
import { main, runCommand } from './main';
import { cliVersion } from './version';

afterEach(cleanupProjects);

describe('main', () => {
  it('prints global help and version without touching the project', async () => {
    const io = createMemoryIO();
    expect(await main([], io)).toBe(0);
    expect(io.out).toContain('Usage: hypdriv <command> [options]');
    const v = createMemoryIO();
    expect(await main(['--version'], v)).toBe(0);
    expect(v.out.trim()).toBe(cliVersion());
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
    const h = createMemoryIO();
    expect(await main(['help', 'audit'], h)).toBe(0);
    expect(h.out).toContain('Usage: hypdriv audit <headers|csp|cache|css|all>');
  });

  it('returns 2 for unknown commands and options, with a suggestion', async () => {
    const io = createMemoryIO();
    expect(await main(['doctr'], io)).toBe(2);
    expect(io.err).toContain('did you mean "doctor"');
    const opt = createMemoryIO();
    expect(await main(['routes', '--bogus'], opt)).toBe(2);
    expect(opt.err).toContain("Unknown option '--bogus'");
    const json = createMemoryIO();
    expect(await main(['routes', '--bogus', '--json'], json)).toBe(2);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, error: { type: 'UsageError' } });
    expect(json.err).toBe('');
  });

  it('accepts global options before the command and --help per command', async () => {
    const p = openNextProject();
    const io = memoryIO('/', {});
    expect(await main(['--root', p.dir, 'doctor', '--json', '--only', 'next.version'], io)).toBe(0);
    expect(JSON.parse(io.out).checks[0]).toMatchObject({ id: 'next.version', status: 'pass' });
    const help = createMemoryIO();
    expect(await runCommand('doctor', ['--help'], help)).toBe(0);
    expect(help.out).toContain('--fix');
  });

  it('validates --platform', async () => {
    const p = tempProject({ 'package.json': '{"name":"x"}' });
    const io = memoryIO(p.dir);
    expect(await runCommand('doctor', ['--platform', 'heroku'], io)).toBe(2);
    expect(io.err).toContain('--platform must be one of cloudflare, vercel, node');
  });

  it('prints exactly one JSON document per command with --json', async () => {
    const p = openNextProject();
    for (const [name, args] of [
      ['doctor', ['--only', 'env.node-version']],
      ['init', ['--dry-run']],
      ['agent', []],
      ['jobs', ['list']],
    ] as const) {
      const io = memoryIO(p.dir);
      await runCommand(name, [...args, '--json'], io);
      expect(() => JSON.parse(io.out), `${name} --json`).not.toThrow();
    }
  });
});
