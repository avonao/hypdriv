import type { CSSProperties } from 'react';

export type ColorScheme = 'light' | 'dark';

export interface Theme {
  scheme: ColorScheme;
  bg: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  good: string;
  warn: string;
  bad: string;
  info: string;
  bar: string;
  chip: string;
}

export const LIGHT: Theme = {
  scheme: 'light',
  bg: '#ffffff',
  panel: '#f6f7f9',
  border: '#d9dde3',
  text: '#111827',
  muted: '#6b7280',
  accent: '#2563eb',
  good: '#15803d',
  warn: '#b45309',
  bad: '#b91c1c',
  info: '#1d4ed8',
  bar: '#dbeafe',
  chip: '#e5e7eb',
};

export const DARK: Theme = {
  scheme: 'dark',
  bg: '#0f1115',
  panel: '#171a21',
  border: '#2a2f3a',
  text: '#e5e7eb',
  muted: '#9ca3af',
  accent: '#60a5fa',
  good: '#4ade80',
  warn: '#fbbf24',
  bad: '#f87171',
  info: '#93c5fd',
  bar: '#1e3a5f',
  chip: '#262b36',
};

export const Z_INDEX = 2147483000;
export const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export type Position = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

export function anchor(position: Position, offset = 12): CSSProperties {
  const style: CSSProperties = { position: 'fixed' };
  if (position.startsWith('bottom')) style.bottom = offset;
  else style.top = offset;
  if (position.endsWith('right')) style.right = offset;
  else style.left = offset;
  return style;
}

export function pillStyle(theme: Theme, position: Position): CSSProperties {
  return {
    ...anchor(position),
    zIndex: Z_INDEX,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    borderRadius: 999,
    border: `1px solid ${theme.border}`,
    background: theme.bg,
    color: theme.text,
    font: `12px/1.2 ${FONT}`,
    boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
    cursor: 'pointer',
    userSelect: 'none',
  };
}

export function panelStyle(theme: Theme, position: Position): CSSProperties {
  return {
    ...anchor(position),
    zIndex: Z_INDEX,
    width: 'min(560px, calc(100vw - 24px))',
    maxHeight: 'min(70vh, 640px)',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 10,
    border: `1px solid ${theme.border}`,
    background: theme.bg,
    color: theme.text,
    font: `12px/1.45 ${FONT}`,
    boxShadow: '0 12px 40px rgba(0,0,0,0.28)',
    overflow: 'hidden',
  };
}

export function headerStyle(theme: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderBottom: `1px solid ${theme.border}`,
    background: theme.panel,
  };
}

export function tabListStyle(theme: Theme): CSSProperties {
  return {
    display: 'flex',
    gap: 2,
    padding: '6px 8px 0',
    borderBottom: `1px solid ${theme.border}`,
    overflowX: 'auto',
  };
}

export function tabStyle(theme: Theme, active: boolean): CSSProperties {
  return {
    appearance: 'none',
    border: 'none',
    borderBottom: `2px solid ${active ? theme.accent : 'transparent'}`,
    background: 'transparent',
    color: active ? theme.text : theme.muted,
    font: 'inherit',
    padding: '4px 8px 6px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

export function bodyStyle(): CSSProperties {
  return { padding: 10, overflow: 'auto', flex: 1 };
}

export function chipStyle(theme: Theme, tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' = 'neutral'): CSSProperties {
  const color = tone === 'good' ? theme.good : tone === 'warn' ? theme.warn : tone === 'bad' ? theme.bad : tone === 'info' ? theme.info : theme.muted;
  return {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: 999,
    background: theme.chip,
    color,
    fontSize: 11,
    lineHeight: '16px',
    whiteSpace: 'nowrap',
  };
}

export function iconButtonStyle(theme: Theme): CSSProperties {
  return {
    appearance: 'none',
    border: `1px solid ${theme.border}`,
    background: 'transparent',
    color: theme.text,
    font: 'inherit',
    borderRadius: 6,
    padding: '2px 7px',
    cursor: 'pointer',
  };
}

export function rowStyle(theme: Theme): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'minmax(90px, 1fr) 64px minmax(80px, 2fr)',
    gap: 8,
    alignItems: 'center',
    padding: '3px 0',
    borderBottom: `1px solid ${theme.border}`,
  };
}

export function mutedStyle(theme: Theme): CSSProperties {
  return { color: theme.muted };
}

export function codeStyle(theme: Theme): CSSProperties {
  return { font: 'inherit', background: theme.panel, padding: '1px 4px', borderRadius: 4, wordBreak: 'break-all' };
}

export const srOnly: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};
