import { createHash } from 'node:crypto';

const css = `body {
  font-family: system-ui, sans-serif;
  margin: 2rem auto;
  max-width: 40rem;
  padding: 0 1rem;
}
`;

/**
 * A content-hashed stylesheet. A bundler would write `assets/styles.<hash>.css` at build time; this example has no
 * build step, so the URL carries a hash of the content and the route below serves it for a year: the hash changes
 * when the content does, so the cache never goes stale.
 */
export const stylesheet = {
  path: `/assets/styles.${createHash('sha256').update(css).digest('hex').slice(0, 10)}.css`,
  css,
};
