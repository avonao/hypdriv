export const metadata = { title: 'About · HypDriv on vinext' };

export default function About() {
  return (
    <>
      <h1>About</h1>
      <p>
        vinext reimplements the Next.js API on Vite. HypDriv runs its Drivetrain (security headers, CSP, rate
        limiting, the bot shield, flags, Early Hints, observability) around every request vinext answers, on
        Cloudflare Workers, Vercel and Node.
      </p>
    </>
  );
}
