import { hyp } from '@hypdriv/rwsdk/server';
import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';
import { prefix, render, route } from 'rwsdk/router';
import { defineApp } from 'rwsdk/worker';
import { Document } from '@/app/Document';
import { About } from '@/app/pages/About';
import { Home } from '@/app/pages/Home';
import { Product } from '@/app/pages/Product';

// `withHypDriv` puts the Hypdriv Drivetrain in front of RedwoodSDK: security headers, the nonce CSP, rate limits,
// the bot shield, geo, flags, Early Hints, logging and /_hypdriv/*. `hypdrivMiddleware()` must come first in the
// routes: it makes RedwoodSDK render its inline scripts with the nonce the CSP allows. The Hypdriv plugin in
// vite.config.mts exports the Durable Object classes (HypDrivLimiter, HypDrivIndex, HypDrivChannel) from this file.
export default withHypDriv(
  defineApp([
    hypdrivMiddleware(),
    render(Document, [
      route('/', Home),
      route('/about', About),
      prefix('/products', [route('/:id', Product)]),
    ]),
    // Rate limited by the `api` policy in hypdriv.config.ts (60 requests per minute per IP).
    route('/api/ping', {
      get: () => {
        const context = hyp();
        return Response.json({
          ok: true,
          requestId: context?.requestId ?? null,
          runner: context?.runner ?? null,
          country: context?.country ?? null,
          flags: context?.flags ?? {},
        });
      },
    }),
  ]),
);
