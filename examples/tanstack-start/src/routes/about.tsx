import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/about')({
  loader: () => ({ builtAt: new Date().toISOString() }),
  component: About,
});

function About() {
  const { builtAt } = Route.useLoaderData();
  return (
    <main>
      <h1>About</h1>
      <p>
        Prerendered at <time dateTime={builtAt}>{builtAt}</time>. The inline hydration data above is allowed
        by its SHA-256 hash, computed by Hypdriv from this exact document.
      </p>
    </main>
  );
}
