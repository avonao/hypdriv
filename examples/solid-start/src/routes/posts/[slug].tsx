import { useParams } from '@solidjs/router';

export default function Post() {
  const params = useParams<{ slug: string }>();
  return (
    <main>
      <h1>{params.slug.replace(/-/g, ' ')}</h1>
      <p>
        A dynamic route (<code>/posts/[slug]</code> in the Hypdriv manifest), rendered on demand.
      </p>
    </main>
  );
}
