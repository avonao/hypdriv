import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/posts/$slug')({
  loader: ({ params }) => ({ slug: params.slug, title: params.slug.replace(/-/g, ' ') }),
  component: Post,
});

function Post() {
  const post = Route.useLoaderData();
  return (
    <main>
      <h1>{post.title}</h1>
      <p>
        A dynamic route (<code>/posts/[slug]</code> in the Hypdriv manifest), rendered on demand.
      </p>
    </main>
  );
}
