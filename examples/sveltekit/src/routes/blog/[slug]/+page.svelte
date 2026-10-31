<script lang="ts">
let { data } = $props();
</script>

<svelte:head>
  <title>{data.title} · HypDriv × SvelteKit</title>
</svelte:head>

<article>
  <h1>{data.title}</h1>
  <p>{data.body}</p>
</article>
