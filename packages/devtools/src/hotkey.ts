/** A parsed keyboard shortcut such as `Alt+Shift+H`. */
export interface Hotkey {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  /** Lower-cased `KeyboardEvent.key` (`'h'`, `'f12'`, `'escape'`, `'/'`). */
  key: string;
}

const MODIFIERS: Record<string, keyof Omit<Hotkey, 'key'>> = {
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  ctrl: 'ctrl',
  control: 'ctrl',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  /** `Mod` = Cmd on macOS, Ctrl elsewhere; resolved at match time. */
  mod: 'ctrl',
};

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  space: ' ',
  spacebar: ' ',
  return: 'enter',
  del: 'delete',
  plus: '+',
};

/**
 * Parses `Alt+Shift+H`, `ctrl-k`, `Mod+/` … into a {@link Hotkey}. Returns `null` for strings without a
 * non-modifier key. Separators `+` and `-` are both accepted (a trailing `+`/`-` is the key itself).
 */
export function parseHotkey(input: string | null | undefined): Hotkey | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const parts: string[] = [];
  let buffer = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const isSeparator = (ch === '+' || ch === '-') && buffer.length > 0 && i < raw.length - 1;
    if (isSeparator) {
      parts.push(buffer);
      buffer = '';
    } else buffer += ch;
  }
  if (buffer) parts.push(buffer);
  const hotkey: Hotkey = { alt: false, shift: false, ctrl: false, meta: false, key: '' };
  let usesMod = false;
  for (const part of parts) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    if (token === 'mod') {
      usesMod = true;
      continue;
    }
    const modifier = MODIFIERS[token];
    if (modifier) hotkey[modifier] = true;
    else hotkey.key = KEY_ALIASES[token] ?? token;
  }
  if (!hotkey.key) return null;
  if (usesMod) {
    if (isApplePlatform()) hotkey.meta = true;
    else hotkey.ctrl = true;
  }
  return hotkey;
}

function isApplePlatform(): boolean {
  try {
    const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
    return /mac|iphone|ipad|ipod/i.test(nav?.platform ?? nav?.userAgent ?? '');
  } catch {
    return false;
  }
}

/** Minimal keyboard event shape (structural, so tests need no DOM). */
export interface KeyboardEventLike {
  key: string;
  code?: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * `true` when the event matches the hotkey. Letters match through `event.code` (`KeyH`) as well as
 * `event.key`, because Alt on macOS produces symbols (`Alt+Shift+H` → `˙`).
 */
export function matchesHotkey(event: KeyboardEventLike, hotkey: Hotkey | null): boolean {
  if (!hotkey) return false;
  if (event.altKey !== hotkey.alt || event.shiftKey !== hotkey.shift) return false;
  if (event.ctrlKey !== hotkey.ctrl || event.metaKey !== hotkey.meta) return false;
  const key = (event.key ?? '').toLowerCase();
  if (key === hotkey.key) return true;
  const code = (event.code ?? '').toLowerCase();
  if (/^[a-z]$/.test(hotkey.key) && code === `key${hotkey.key}`) return true;
  if (/^[0-9]$/.test(hotkey.key) && code === `digit${hotkey.key}`) return true;
  if (/^f\d{1,2}$/.test(hotkey.key) && code === hotkey.key) return true;
  return false;
}

/** Human-readable form for labels (`Alt+Shift+H`). */
export function formatHotkey(hotkey: Hotkey | null): string {
  if (!hotkey) return '';
  const parts: string[] = [];
  if (hotkey.ctrl) parts.push('Ctrl');
  if (hotkey.alt) parts.push('Alt');
  if (hotkey.shift) parts.push('Shift');
  if (hotkey.meta) parts.push('Cmd');
  parts.push(
    hotkey.key.length === 1
      ? hotkey.key.toUpperCase()
      : hotkey.key.charAt(0).toUpperCase() + hotkey.key.slice(1),
  );
  return parts.join('+');
}
