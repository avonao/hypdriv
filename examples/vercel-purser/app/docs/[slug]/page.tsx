import { css } from '@avonao/purser';
import type { Metadata } from 'next';
import { cacheLife, cacheTag } from 'next/cache';
import { notFound } from 'next/navigation';
import { Card } from '@/components/card';
import { text } from '@/lib/styles';

const docs = {
  themes: {
    title: 'Flashless themes',
    body: 'Toggle dark mode or high contrast in the header and reload: the hashed theme script pins the classes from the hyp_theme cookie before first paint, so the page never flashes. Without a cookie, Sec-CH-Prefers-Color-Scheme and Sec-CH-Prefers-Contrast decide.',
  },
  guard: {
    title: 'Unstyled-atom guard',
    body: 'After next build, HypDriv collects every prerendered document and RSC payload, extracts the Purser classes they use and compares them with the generated stylesheet. Missing atoms fail the build (purser.verify: "error").',
  },
  audit: {
    title: 'Zero-override audit',
    body: "Run pnpm build && pnpm start, then pnpm audit:css. Every route is evaluated with Purser's strike-count script at 375, 768 and 1280 pixels, in light and dark, at rest, on hover and with keyboard focus. Any struck-through declaration fails the audit.",
  },
} as const;

type Slug = keyof typeof docs;

export function generateStaticParams(): Array<{ slug: Slug }> {
  return (Object.keys(docs) as Slug[]).map((slug) => ({ slug }));
}

async function getDoc(slug: string) {
  'use cache';
  cacheLife('hours');
  cacheTag('docs', `doc:${slug}`);
  return docs[slug as Slug] ?? null;
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await props.params;
  const doc = await getDoc(slug);
  return doc ? { title: doc.title } : {};
}

export default async function DocPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const doc = await getDoc(slug);
  if (!doc) notFound();
  return (
    <>
      <h1 className={css.props(text.title)}>{doc.title}</h1>
      <p className={css.props(text.lead)}>{doc.body}</p>
      <Card title="Back to the overview" href="/">
        All features of the HypDriv × Purser integration.
      </Card>
    </>
  );
}
