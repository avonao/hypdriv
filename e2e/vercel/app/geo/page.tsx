import { hyp } from 'hypdriv/server';

export default async function Geo() {
  const ctx = await hyp();
  return (
    <>
      <h1>Geo</h1>
      <pre id="geo">{JSON.stringify({ geo: ctx.geo, country: ctx.country, colo: ctx.cf?.colo ?? null })}</pre>
    </>
  );
}
