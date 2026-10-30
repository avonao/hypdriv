import { unstable_cache } from 'next/cache';

// Static until `revalidateTag('e2e-tagged')`: the tag cache (Durable Object) marks it stale and the
// HypDriv edge cache entry is purged by tag.
export const dynamic = 'force-static';

const stamp = unstable_cache(async () => new Date().toISOString(), ['e2e-tagged-stamp'], {
  tags: ['e2e-tagged'],
});

export default async function Tagged() {
  return (
    <>
      <h1>Tagged</h1>
      <p>
        stamped <time id="stamped">{await stamp()}</time>
      </p>
    </>
  );
}
