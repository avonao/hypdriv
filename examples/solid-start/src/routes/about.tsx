// Prerendered at build time. The page is rendered once, so the inline hydration script is the same for every
// visitor: Hypdriv computes its SHA-256 from this exact document and allows it by hash.
export default function About() {
  const builtAt = new Date().toISOString();
  return (
    <main>
      <h1>About</h1>
      <p>
        Prerendered at <time dateTime={builtAt}>{builtAt}</time>. The inline hydration script is allowed by
        its SHA-256 hash.
      </p>
    </main>
  );
}
