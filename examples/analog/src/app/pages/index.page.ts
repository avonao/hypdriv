import type { RouteMeta } from '@analogjs/router';
import { Component } from '@angular/core';

export const routeMeta: RouteMeta = { title: 'Hypdriv × Analog' };

// Prerendered at build time (`prerender.routes` in vite.config.ts): the CSP carries the hashes of its inline code.
@Component({
  selector: 'app-home',
  template: `
    <h1>Hypdriv × Analog</h1>
    <p>
      This page is prerendered. Hypdriv computed the hash of every inline script at build time and serves it with a
      hash-based Content-Security-Policy, security headers and Early Hints.
    </p>
    <p>
      <a href="/ssr">/ssr</a> is rendered per request with a fresh nonce; <code>/api/hello</code> is a Nitro route
      behind the same pipeline.
    </p>
  `,
})
export default class HomePage {}
