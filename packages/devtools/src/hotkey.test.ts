import { describe, expect, it } from 'vitest';
import { formatHotkey, matchesHotkey, parseHotkey } from './hotkey';

describe('parseHotkey', () => {
  it('parses modifier combinations and aliases', () => {
    expect(parseHotkey('Alt+Shift+H')).toEqual({
      alt: true,
      shift: true,
      ctrl: false,
      meta: false,
      key: 'h',
    });
    expect(parseHotkey('ctrl-k')).toEqual({ alt: false, shift: false, ctrl: true, meta: false, key: 'k' });
    expect(parseHotkey('Cmd+Option+/')).toEqual({
      alt: true,
      shift: false,
      ctrl: false,
      meta: true,
      key: '/',
    });
    expect(parseHotkey('F12')).toEqual({ alt: false, shift: false, ctrl: false, meta: false, key: 'f12' });
    expect(parseHotkey('Esc')).toMatchObject({ key: 'escape' });
    expect(parseHotkey('Ctrl+Plus')).toMatchObject({ ctrl: true, key: '+' });
    expect(parseHotkey('Shift++')).toMatchObject({ shift: true, key: '+' });
    expect(parseHotkey('Alt+-')).toMatchObject({ alt: true, key: '-' });
  });

  it('rejects empty or modifier-only strings', () => {
    expect(parseHotkey('')).toBeNull();
    expect(parseHotkey(null)).toBeNull();
    expect(parseHotkey('Alt+Shift')).toBeNull();
  });

  it('resolves Mod to Ctrl outside Apple platforms', () => {
    const hk = parseHotkey('Mod+K');
    expect(hk).not.toBeNull();
    expect(hk!.ctrl || hk!.meta).toBe(true);
    expect(hk!.ctrl && hk!.meta).toBe(false);
  });
});

describe('matchesHotkey', () => {
  const hk = parseHotkey('Alt+Shift+H');
  const base = { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false };

  it('matches by key or by code (macOS Alt produces symbols)', () => {
    expect(matchesHotkey({ ...base, key: 'H', altKey: true, shiftKey: true }, hk)).toBe(true);
    expect(matchesHotkey({ ...base, key: '˙', code: 'KeyH', altKey: true, shiftKey: true }, hk)).toBe(true);
    expect(matchesHotkey({ ...base, key: 'h', altKey: true }, hk)).toBe(false);
    expect(matchesHotkey({ ...base, key: 'h', altKey: true, shiftKey: true, ctrlKey: true }, hk)).toBe(false);
    expect(matchesHotkey({ ...base, key: 'g', code: 'KeyG', altKey: true, shiftKey: true }, hk)).toBe(false);
    expect(matchesHotkey({ ...base, key: 'h' }, null)).toBe(false);
  });

  it('matches digits and function keys through codes', () => {
    expect(matchesHotkey({ ...base, key: '!', code: 'Digit1', shiftKey: true }, parseHotkey('Shift+1'))).toBe(
      true,
    );
    expect(matchesHotkey({ ...base, key: 'F12', code: 'F12' }, parseHotkey('f12'))).toBe(true);
  });
});

describe('formatHotkey', () => {
  it('renders a readable label', () => {
    expect(formatHotkey(parseHotkey('alt+shift+h'))).toBe('Alt+Shift+H');
    expect(formatHotkey(parseHotkey('ctrl+escape'))).toBe('Ctrl+Escape');
    expect(formatHotkey(null)).toBe('');
  });
});
