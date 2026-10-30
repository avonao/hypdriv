import Image from 'next/image';

export default function Images() {
  return (
    <>
      <h1>Images</h1>
      <Image id="hero" src="/e2e-assets/pattern.png" alt="Test pattern" width={256} height={256} priority />
    </>
  );
}
