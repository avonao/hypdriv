import { component$ } from '@qwik.dev/core';
import { type DocumentHead, type StaticGenerateHandler, useLocation } from '@qwik.dev/router';

export default component$(() => {
  const { params } = useLocation();
  return (
    <>
      <h1>Post: {params.slug}</h1>
      <p>
        A dynamic route with prerendered paths (<code>onStaticGenerate</code>): <code>/blog/hello/</code> and{' '}
        <code>/blog/qwik/</code> are files, any other slug renders per request.
      </p>
    </>
  );
});

export const onStaticGenerate: StaticGenerateHandler = () => ({
  params: [{ slug: 'hello' }, { slug: 'qwik' }],
});

export const head: DocumentHead = ({ params }) => ({ title: `${params.slug} · Hypdriv on Qwik` });
