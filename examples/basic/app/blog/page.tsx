import Link from 'next/link';

const posts = [
  { slug: 'hello-world', title: 'Hello world' },
  { slug: 'second-post', title: 'Second post' },
];

export default function Blog() {
  return (
    <>
      <h1>Blog</h1>
      <ul>
        {posts.map((p) => (
          <li key={p.slug}>
            <Link href={`/blog/${p.slug}`} prefetch>
              {p.title}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
