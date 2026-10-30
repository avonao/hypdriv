import { cacheLife, cacheTag } from 'next/cache';
import { notFound } from 'next/navigation';

const posts: Record<string, { title: string; body: string }> = {
  'hello-world': {
    title: 'Hello world',
    body: 'The first post, revalidated every minute and cached at the edge for ten.',
  },
  'second-post': {
    title: 'Second post',
    body: 'Edit this file, redeploy, and watch `revalidateTag("blog")` purge both caches.',
  },
};

export async function generateStaticParams() {
  return Object.keys(posts).map((slug) => ({ slug }));
}

async function getPost(slug: string) {
  'use cache';
  cacheLife('minutes');
  cacheTag('blog', `post:${slug}`);
  return posts[slug] ?? null;
}

export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </article>
  );
}
