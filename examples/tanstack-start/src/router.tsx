import { hypdrivSsr } from '@hypdriv/tanstack-start';
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

// `getRouter()` runs per request on the server, after the request middleware: `hypdrivSsr()` hands the request's
// CSP nonce to the router, which puts it on every script and style tag it renders (and reads it back on the client).
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    ssr: hypdrivSsr(),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
