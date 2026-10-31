import { hyp } from 'hypdriv/server';

// Cached at the edge per country (`vary: { geo: ['country'] }`).
export default async function GeoCached() {
  const ctx = await hyp();
  return (
    <>
      <h1>Geo (cached per country)</h1>
      <p id="country">{ctx.country ?? 'unknown'}</p>
      <p id="rendered">{new Date().toISOString()}</p>
    </>
  );
}
