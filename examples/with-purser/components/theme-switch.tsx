'use client';

import { css } from '@avonao/purser';
import { useEffect, useState } from 'react';
import { t } from '@/lib/tokens';

type Mode = 'light' | 'dark';
type Contrast = 'normal' | 'high';

const COOKIE = 'hyp_theme';

const s = css.create({
  group: { display: 'flex', gap: t.space[2] },
  button: {
    paddingBlock: t.space[1],
    paddingInline: t.space[3],
    borderRadius: t.radius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: t.color.line,
    backgroundColor: { default: t.color.surface, '[aria-pressed="true"]': t.color.accent },
    color: { default: t.color.text, '[aria-pressed="true"]': t.color.accentText },
    cursor: 'pointer',
    fontSize: '0.875rem',
  },
});

function readTheme(): { mode: Mode; contrast: Contrast } {
  const root = document.documentElement;
  return { mode: root.classList.contains('dark') ? 'dark' : 'light', contrast: root.classList.contains('hc') ? 'high' : 'normal' };
}

/**
 * Writes the `hyp_theme` cookie read by HypDriv's `theme` stage (and the fallback script), then applies the
 * classes immediately. The next document request is pinned at the edge, so there is no flash on reload.
 */
function persist(next: { mode: Mode; contrast: Contrast }) {
  const value = encodeURIComponent(`contrast=${next.contrast};mode=${next.mode}`);
  document.cookie = `${COOKIE}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  const root = document.documentElement;
  root.classList.toggle('dark', next.mode === 'dark');
  root.classList.toggle('hc', next.contrast === 'high');
  root.setAttribute('data-hypdriv-theme', `contrast=${next.contrast};mode=${next.mode}`);
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState<{ mode: Mode; contrast: Contrast } | null>(null);
  useEffect(() => setTheme(readTheme()), []);
  if (!theme) return <div className={css.props(s.group)} aria-hidden="true" />;
  const update = (patch: Partial<typeof theme>) => {
    const next = { ...theme, ...patch };
    persist(next);
    setTheme(next);
  };
  return (
    <div className={css.props(s.group)} role="group" aria-label="Theme">
      <button type="button" className={css.props(s.button)} aria-pressed={theme.mode === 'dark'} onClick={() => update({ mode: theme.mode === 'dark' ? 'light' : 'dark' })}>
        Dark
      </button>
      <button type="button" className={css.props(s.button)} aria-pressed={theme.contrast === 'high'} onClick={() => update({ contrast: theme.contrast === 'high' ? 'normal' : 'high' })}>
        High contrast
      </button>
    </div>
  );
}
