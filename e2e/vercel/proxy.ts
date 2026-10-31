import { createProxy } from 'hypdriv/proxy';
import hypdrivConfig from './hypdriv.config';

// On Vercel the proxy wires @hypdriv/vercel itself: Global Config / Upstash stores, CDN headers, purges.
export default createProxy(hypdrivConfig);

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|js|map|txt|xml|json)$).*)',
    '/_hypdriv/:path*',
  ],
};
