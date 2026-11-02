import { flag, hyp } from '@hypdriv/nitro/server';
import { defineHandler } from 'nitro';
import { page } from '../utils/page';

// Rendered per request: the CSP carries a fresh nonce, which the page stamps on its inline style and script.
export default defineHandler(() => {
  const context = hyp();
  const rows = [
    ['Request id', context?.requestId ?? '-'],
    ['Runner', context?.runner ?? '-'],
    ['Country', context?.country ?? '-'],
    ['newHero', String(flag('newHero', false))],
  ];
  return page({
    title: 'Request facts',
    body: `<h1>Request facts</h1>
<p>Rendered on the server with <code>hyp()</code>.</p>
<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd><code>${v}</code></dd>`).join('')}</dl>`,
  });
});
