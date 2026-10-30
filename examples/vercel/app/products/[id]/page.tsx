import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getProduct, listProducts } from '@/lib/catalog';

export async function generateStaticParams() {
  return (await listProducts()).map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }: PageProps<'/products/[id]'>): Promise<Metadata> {
  const product = await getProduct((await params).id);
  return { title: product?.name ?? 'Product' };
}

export default async function ProductPage({ params }: PageProps<'/products/[id]'>) {
  'use cache';
  const product = await getProduct((await params).id);
  if (!product) notFound();
  return (
    <article className="card">
      <h1>{product.name}</h1>
      <p>{product.description}</p>
      <p>
        <strong>${product.price}</strong>
      </p>
      <p>
        HypDriv&apos;s <code>products</code> policy adds <code>Vercel-CDN-Cache-Control</code> and the{' '}
        <code>catalog</code> cache tag; <code>revalidateTag(&apos;catalog&apos;)</code> from{' '}
        <code>hypdriv/cache</code> purges it on Vercel&apos;s CDN.
      </p>
    </article>
  );
}
