<script lang="ts">
let { data } = $props();
</script>

<svelte:head>
  <title>Request facts · HypDriv × SvelteKit</title>
  <!-- An inline script of the application's own, carrying the request's nonce from `nonce()`. -->
  {@html data.inlineScript}
</svelte:head>

<h1>Request facts</h1>
<dl>
  <dt>Request id</dt>
  <dd data-testid="request-id">{data.requestId}</dd>
  <dt>Runner</dt>
  <dd data-testid="runner">{data.runner}</dd>
  <dt>Route</dt>
  <dd data-testid="route">{data.route}</dd>
  <dt>Country</dt>
  <dd>{data.country ?? 'unknown'}</dd>
  <dt>CSP mode</dt>
  <dd>{data.cspMode}</dd>
  <dt>Nonce</dt>
  <dd data-testid="nonce">{data.nonce}</dd>
  <dt>Flag <code>newHero</code></dt>
  <dd data-testid="flag">{String(data.newHero)}</dd>
  <dt>Streamed</dt>
  <dd>
    {#await data.streamed}
      loading…
    {:then value}
      {value}
    {/await}
  </dd>
</dl>
