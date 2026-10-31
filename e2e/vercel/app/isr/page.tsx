// Time-based ISR: Vercel regenerates the page in the background once it is older than 15 s.
export const revalidate = 15;

export default function Isr() {
  const generatedAt = new Date().toISOString();
  return (
    <>
      <h1>ISR</h1>
      <p>
        generated <time id="generated">{generatedAt}</time>
      </p>
    </>
  );
}
