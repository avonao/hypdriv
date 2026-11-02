import { flag, hyp } from '@hypdriv/nitro/server';
import { defineEventHandler } from 'h3';
import { page } from '../utils/page';

// Rendered per request: the CSP carries a fresh nonce, which the page stamps on its inline style and script.
export default defineEventHandler((event) => {
  const context = hyp();
  const rows = [
    ['Request id', context?.requestId ?? '-'],
    ['Runner', context?.runner ?? '-'],
    ['Country', context?.country ?? '-'],
    ['newHero', String(flag('newHero', false))],
  ];
  return page(event, {
    title: 'Request facts',
    body: `<h1>Request facts</h1>
<p>Rendered on the server with <code>hyp()</code>.</p>
<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd><code>${v}</code></dd>`).join('')}</dl>`,
  });
});
