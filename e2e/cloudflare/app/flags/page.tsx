import { flag } from 'hypdriv/server';

export default async function Flags() {
  const banner = await flag('e2eBanner', false);
  return (
    <>
      <h1>Flags</h1>
      <p id="banner">{banner ? 'banner-on' : 'banner-off'}</p>
    </>
  );
}
