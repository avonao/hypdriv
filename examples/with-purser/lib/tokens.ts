import { defineTokens } from '@avonao/purser';

/** Breakpoints used as style conditions. */
export const bp = {
  md: '@media (width >= 768px)',
  motion: '@media (prefers-reduced-motion: no-preference)',
} as const;

/**
 * Design tokens. The `mode` and `contrast` axes are root classes on `<html>`; HypDriv's `theme` stage pins
 * them at the edge from the `hyp_theme` cookie or the `Sec-CH-Prefers-*` client hints (hypdriv.config.ts).
 */
export const t = defineTokens({
  axes: {
    mode: { light: ':not(.dark)', dark: '.dark' },
    contrast: { normal: ':not(.hc)', high: '.hc' },
  },
  tokens: {
    color: {
      canvas: {
        default: '#fbfaf8',
        'mode=dark': '#111214',
        'contrast=high': '#ffffff',
        'mode=dark&contrast=high': '#000000',
      },
      surface: { default: '#ffffff', 'mode=dark': '#1a1c1f', 'mode=dark&contrast=high': '#0a0a0a' },
      text: {
        default: '#1b1c1e',
        'mode=dark': '#ececee',
        'contrast=high': '#000000',
        'mode=dark&contrast=high': '#ffffff',
      },
      muted: {
        default: '#5d6168',
        'mode=dark': '#a2a6ad',
        'contrast=high': '#2b2d31',
        'mode=dark&contrast=high': '#d8dadd',
      },
      accent: {
        default: 'oklch(52% 0.13 175)',
        'mode=dark': 'oklch(78% 0.12 175)',
        'contrast=high': 'oklch(40% 0.12 175)',
        'mode=dark&contrast=high': 'oklch(86% 0.11 175)',
      },
      accentText: { default: '#ffffff', 'mode=dark': '#06201c' },
      line: {
        default: 'rgb(0 0 0 / 0.1)',
        'mode=dark': 'rgb(255 255 255 / 0.12)',
        'contrast=high': 'rgb(0 0 0 / 0.6)',
        'mode=dark&contrast=high': 'rgb(255 255 255 / 0.7)',
      },
    },
    space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 6: '24px', 8: '32px', 12: '48px' },
    radius: { sm: '6px', md: '12px', full: '999px' },
    font: {
      body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      mono: 'ui-monospace, "SF Mono", Menlo, monospace',
    },
  },
});
