import type { RouteMeta } from '@analogjs/router';
import { Component } from '@angular/core';

export const routeMeta: RouteMeta = { title: 'About' };

@Component({
  selector: 'app-about',
  template: `
    <h1>About</h1>
    <p>
      Hypdriv wraps Analog's Nitro server: the file router's pages, the API routes in <code>src/server/routes</code>
      and the prerendered documents all pass through one pipeline, on Cloudflare Workers, Vercel and Node.
    </p>
  `,
})
export default class AboutPage {}
