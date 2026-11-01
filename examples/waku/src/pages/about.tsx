// Prerendered too: a second static page for the checks.
export default async function About() {
  return (
    <>
      <title>About · Hypdriv on Waku</title>
      <h1>About</h1>
      <p>
        Waku renders React Server Components on Vite. Hypdriv wraps its server entry, so the same request
        stages run for pages, RSC payloads, server functions and API routes on every platform.
      </p>
    </>
  );
}

export const getConfig = async () => ({ render: 'static' }) as const;
