import type { RouteMeta } from '@analogjs/router';
import { Component } from '@angular/core';
import { injectRequestFacts } from '../request-facts';

export const routeMeta: RouteMeta = { title: 'Request facts' };

// Not prerendered: Analog renders it per request, the CSP carries a fresh nonce, and Angular stamps that nonce on the
// scripts and styles it renders (`provideHypDriv()` in app.config.server.ts).
@Component({
  selector: 'app-ssr',
  template: `
    <h1>Request facts</h1>
    <p>Rendered on the server with <code>injectHyp()</code>.</p>
    @if (facts) {
      <dl>
        <dt>Request id</dt>
        <dd>
          <code>{{ facts.requestId ?? '-' }}</code>
        </dd>
        <dt>Runner</dt>
        <dd>
          <code>{{ facts.runner ?? '-' }}</code>
        </dd>
        <dt>Country</dt>
        <dd>
          <code>{{ facts.country ?? '-' }}</code>
        </dd>
        <dt>CSP mode</dt>
        <dd>
          <code>{{ facts.cspMode ?? '-' }}</code>
        </dd>
        <dt>newHero</dt>
        <dd>
          <code>{{ facts.newHero }}</code>
        </dd>
      </dl>
    } @else {
      <p>No Hypdriv request context (development server or a plain prerender).</p>
    }
  `,
})
export default class SsrPage {
  protected readonly facts = injectRequestFacts();
}
