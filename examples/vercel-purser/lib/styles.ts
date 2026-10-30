import { css } from '@avonao/purser';
import { bp, t } from './tokens';

/** Document-level rules that cannot be atoms. */
css.globals({
  html: { backgroundColor: t.color.canvas, color: t.color.text, fontFamily: t.font.body, lineHeight: '1.5' },
  body: { margin: '0' },
  '::selection': { backgroundColor: t.color.accent, color: t.color.accentText },
});

/** Shared layout styles. */
export const layout = css.create({
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: t.space[4],
    paddingBlock: t.space[4],
    paddingInline: t.space[6],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: t.color.line,
  },
  brand: { fontWeight: '700', color: t.color.text, textDecorationLine: 'none' },
  nav: { display: 'flex', gap: t.space[4] },
  navLink: {
    color: { default: t.color.muted, ':hover': t.color.accent, ':focus-visible': t.color.accent },
    textDecorationLine: { default: 'none', ':hover': 'underline' },
  },
  main: {
    maxWidth: '56rem',
    marginInline: 'auto',
    paddingBlock: { default: t.space[6], [bp.md]: t.space[12] },
    paddingInline: t.space[6],
  },
});

export const text = css.create({
  title: { fontSize: { default: '2rem', [bp.md]: '2.75rem' }, lineHeight: '1.15', marginBlock: '0' },
  lead: {
    fontSize: '1.125rem',
    color: t.color.muted,
    marginBlockStart: t.space[3],
    marginBlockEnd: t.space[8],
  },
  code: { fontFamily: t.font.mono, fontSize: '0.875em' },
});
