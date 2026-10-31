<svelte:head>
  <title>Hypdriv × SvelteKit</title>
</svelte:head>

<h1>Hypdriv × SvelteKit</h1>
<p>
  This page is prerendered. Its policy is a hash CSP from the static header rules Hypdriv wrote for the platform
  (Cloudflare <code>_headers</code>, Vercel <code>config.json</code>, or the Node server's pipeline).
</p>
<ul>
  <li><a href="/ssr">Request facts</a> — rendered per request, with Hypdriv's nonce and flags</li>
  <li><a href="/api/hello">API endpoint</a> — rate limited (<code>/api/**</code>)</li>
  <li><a href="/_hypdriv/health" rel="external">/_hypdriv/health</a> — answered by Hypdriv (excluded from the prerender crawl)</li>
</ul>
