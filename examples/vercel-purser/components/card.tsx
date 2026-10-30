import { css } from '@avonao/purser';
import type { ReactNode } from 'react';
import { bp, t } from '@/lib/tokens';

const s = css.create({
  card: {
    display: 'block',
    padding: { default: t.space[4], [bp.md]: t.space[6] },
    backgroundColor: t.color.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: t.color.line, ':hover': t.color.accent },
    borderRadius: t.radius.md,
    color: t.color.text,
    textDecorationLine: 'none',
  },
  interactive: {
    transitionProperty: { default: 'none', [bp.motion]: 'border-color' },
    transitionDuration: '150ms',
  },
  heading: { marginBlock: '0', fontSize: '1.125rem' },
  body: { marginBlockStart: t.space[2], marginBlockEnd: '0', color: t.color.muted },
});

export function Card(props: { title: string; children: ReactNode; href?: string }) {
  const content = (
    <>
      <h2 className={css.props(s.heading)}>{props.title}</h2>
      <p className={css.props(s.body)}>{props.children}</p>
    </>
  );
  if (props.href) {
    return (
      <a href={props.href} className={css.props(s.card, s.interactive)}>
        {content}
      </a>
    );
  }
  return <section className={css.props(s.card)}>{content}</section>;
}

const grid = css.create({
  grid: {
    display: 'grid',
    gap: t.space[4],
    gridTemplateColumns: { default: '1fr', [bp.md]: 'repeat(2, minmax(0, 1fr))' },
  },
});

export function CardGrid(props: { children: ReactNode }) {
  return <div className={css.props(grid.grid)}>{props.children}</div>;
}
