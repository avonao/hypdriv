import { createProxy } from 'hypdriv/proxy';
import hypdrivConfig from './hypdriv.config';

// Runs the Hypdriv stages on `next dev` / `next start`. Inside the Cloudflare Worker the shell has already
// run them, so this proxy passes requests straight through there.
export default createProxy(hypdrivConfig);

// Next.js reads this statically: keep it a literal (same as `matcher` from 'hypdriv/proxy').
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|js|map|txt|xml|json)$).*)',
    '/_hypdriv/:path*',
  ],
};
