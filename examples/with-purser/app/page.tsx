import { css } from '@avonao/purser';
import { Card, CardGrid } from '@/components/card';
import { text } from '@/lib/styles';

export default function Home() {
  return (
    <>
      <h1 className={css.props(text.title)}>Atomic CSS that cannot be overridden, served from the edge.</h1>
      <p className={css.props(text.lead)}>
        Purser compiles this page&apos;s styles into one deterministic stylesheet; Hypdriv builds it inside{' '}
        <code className={css.props(text.code)}>next build</code>, proves every prerendered class exists,
        preloads it with Early Hints and pins your theme before the first byte reaches the browser.
      </p>
      <CardGrid>
        <Card title="Flashless themes" href="/docs/themes">
          The theme stage reads the hyp_theme cookie or Sec-CH-Prefers-* hints and sets the classes on html at
          the edge.
        </Card>
        <Card title="Unstyled-atom guard" href="/docs/guard">
          A build whose HTML references an atom missing from the stylesheet fails instead of shipping unstyled
          markup.
        </Card>
        <Card title="Zero-override audit" href="/docs/audit">
          hypdriv audit css loads every route in headless Chrome at three widths, both themes, hover and
          focus.
        </Card>
        <Card title="Strict CSP">
          Static pages get a hash-based policy that includes the theme fallback script; dynamic pages get a
          nonce.
        </Card>
      </CardGrid>
    </>
  );
}
