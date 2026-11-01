// @refresh reload
import { hypdrivStart } from '@hypdriv/solid-start';
import { createHandler, StartServer } from '@solidjs/start/server';

// The Hypdriv Drivetrain wraps this handler from outside (a Nitro plugin on Node and Vercel, the Worker shell in
// src/worker.ts on Cloudflare). `hypdrivStart()` hands the request's CSP nonce to Solid, so its hydration script and
// the scripts it streams carry the nonce the response's Content-Security-Policy allows; prerendered pages get none.
export default createHandler(
  () => (
    <StartServer
      document={({ assets, children, scripts }) => (
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Hypdriv × SolidStart</title>
            <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
            {assets}
          </head>
          <body>
            <div id="app">{children}</div>
            {scripts}
          </body>
        </html>
      )}
    />
  ),
  hypdrivStart(),
);
