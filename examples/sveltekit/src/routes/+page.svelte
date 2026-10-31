<svelte:head>
  <title>HypDriv × SvelteKit</title>
</svelte:head>

<h1>HypDriv × SvelteKit</h1>
<p>
  This page is prerendered. Its policy is a hash CSP from the static header rules HypDriv wrote for the platform
  (Cloudflare <code>_headers</code>, Vercel <code>config.json</code>, or the Node server's pipeline).
</p>
<ul>
  <li><a href="/ssr">Request facts</a> — rendered per request, with HypDriv's nonce and flags</li>
  <li><a href="/api/hello">API endpoint</a> — rate limited (<code>/api/**</code>)</li>
  <li><a href="/_hypdriv/health" rel="external">/_hypdriv/health</a> — answered by HypDriv (excluded from the prerender crawl)</li>
</ul>
