import { error } from '@sveltejs/kit';

const posts: Record<string, { title: string; body: string }> = {
  'hello-world': { title: 'Hello, world', body: 'A dynamic route prerendered for each entry.' },
  'edge-first': { title: 'Edge first', body: 'Every prerendered path gets its own CSP hashes.' },
};

export const prerender = true;

export const entries = () => Object.keys(posts).map((slug) => ({ slug }));

export const load = ({ params }: { params: { slug: string } }) => {
  const post = posts[params.slug];
  if (!post) error(404, 'Not found');
  return { slug: params.slug, ...post };
};
