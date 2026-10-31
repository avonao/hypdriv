<script lang="ts">
import { enhance } from '$app/forms';

let { form } = $props();
</script>

<svelte:head>
  <title>Form · Hypdriv × SvelteKit</title>
</svelte:head>

<h1>Form action</h1>
<form method="POST" use:enhance>
  <label>Name <input name="name" autocomplete="name" /></label>
  <button>Send</button>
</form>

{#if form?.error}
  <p role="alert">{form.error}</p>
{:else if form?.greeting}
  <p data-testid="greeting">{form.greeting} (request {form.requestId})</p>
{/if}
