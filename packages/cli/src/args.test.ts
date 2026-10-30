import { describe, expect, it } from 'vitest';
import { parseCommandArgs, renderCommandHelp, renderGlobalHelp, UsageError } from './args';
import { commands } from './commands/index';
import { colorEnabled, createPalette, renderTable, stripAnsi, visibleWidth } from './ui';

describe('parseCommandArgs', () => {
  const spec = {
    url: { type: 'string' as const, description: 'base' },
    paths: { type: 'string' as const, multiple: true, description: 'paths' },
    n: { type: 'string' as const, description: 'count' },
    fix: { type: 'boolean' as const, description: 'fix' },
  };

  it('parses globals, strings, booleans, lists and positionals', () => {
    const args = parseCommandArgs(
      [
        'headers',
        '--url',
        'http://x',
        '--paths',
        '/a,/b',
        '--paths',
        '/c',
        '--json',
        '--root',
        'apps/web',
        '--fix',
        '--platform',
        'vercel',
      ],
      spec,
    );
    expect(args.positionals).toEqual(['headers']);
    expect(args.string('url')).toBe('http://x');
    expect(args.list('paths')).toEqual(['/a', '/b', '/c']);
    expect(args.json).toBe(true);
    expect(args.root).toBe('apps/web');
    expect(args.boolean('fix')).toBe(true);
    expect(args.string('platform')).toBe('vercel');
    expect(args.help).toBe(false);
    expect(args.color).toBeUndefined();
  });

  it('validates numbers and reports usage errors', () => {
    expect(parseCommandArgs(['--n', '5'], spec).number('n', 1)).toBe(5);
    expect(parseCommandArgs([], spec).number('n', 7)).toBe(7);
    expect(() => parseCommandArgs(['--n', 'x'], spec).number('n', 1)).toThrow(UsageError);
    expect(() => parseCommandArgs(['--n', '0'], spec).number('n', 1, { min: 1 })).toThrow(/at least 1/);
    expect(() => parseCommandArgs(['--unknown'], spec)).toThrow(UsageError);
    expect(() => parseCommandArgs(['--url'], spec)).toThrow(UsageError);
    expect(parseCommandArgs(['--no-color', '-h'], spec)).toMatchObject({ color: false, help: true });
  });

  it('renders help for every command and the global help', () => {
    for (const command of commands) {
      const help = renderCommandHelp(command);
      expect(help).toContain(`Usage: hypdriv ${command.name}`);
      expect(help).toContain('--json');
      expect(help).toContain('--root <dir>');
      expect(help).toContain('Exit codes');
    }
    const global = renderGlobalHelp(commands, '1.2.3');
    expect(global).toContain('hypdriv 1.2.3');
    for (const c of commands) expect(global).toContain(`  ${c.name}`);
  });
});

describe('ui', () => {
  it('renders aligned tables without colours', () => {
    const table = renderTable(
      [
        ['/', '12.3 kB', 'static'],
        ['/blog/[slug]', '1 B', 'isr'],
      ],
      { columns: ['route', { header: 'JS', align: 'right' }, 'class'] },
    );
    expect(table).toBe(
      [
        'route              JS  class',
        '────────────  ───────  ──────',
        '/             12.3 kB  static',
        '/blog/[slug]      1 B  isr',
        '',
      ].join('\n'),
    );
  });

  it('measures visible width ignoring ANSI and truncates long cells', () => {
    const p = createPalette(true);
    expect(visibleWidth(p.red('abc'))).toBe(3);
    expect(stripAnsi(p.bold('x'))).toBe('x');
    const t = renderTable([['abcdefghij']], { columns: [{ header: 'c', maxWidth: 5 }], rule: false });
    expect(t).toBe('c\nabcd…\n');
  });

  it('respects NO_COLOR, FORCE_COLOR and TTY detection', () => {
    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({ TERM: 'dumb' }, true)).toBe(false);
    expect(createPalette(false).red('x')).toBe('x');
  });
});
