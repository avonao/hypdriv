<script setup lang="ts">
// Rendered per request. `useHyp()` (auto-imported by @hypdriv/nuxt) returns Hypdriv's facts about this request,
// serialised into Nuxt's payload so they hydrate unchanged.
// biome-ignore lint/correctness/noUnusedVariables: used in the template
const hyp = useHyp();
// The nonce is deliberately not part of `useHyp()`; this demo page opts in to showing it.
// biome-ignore lint/correctness/noUnusedVariables: used in the template
const nonce = useState('demo:nonce', () => useHypNonce() ?? null);

useHead({
  title: 'Request facts — Hypdriv for Nuxt',
  // An inline script: Nuxt renders it with the request's nonce, so the nonce-based CSP allows it.
  script: [{ innerHTML: 'document.documentElement.dataset.hypdriv = "inline-script-ran";' }],
});
</script>

<template>
  <main>
    <h1>Request facts</h1>
    <dl v-if="hyp">
      <dt>Request id</dt>
      <dd data-testid="request-id">{{ hyp.requestId }}</dd>
      <dt>CSP nonce</dt>
      <dd data-testid="nonce">{{ nonce ?? '(none)' }}</dd>
      <dt>Runner</dt>
      <dd data-testid="runner">{{ hyp.runner }}</dd>
      <dt>Route</dt>
      <dd>{{ hyp.route ?? '(unmatched)' }}</dd>
      <dt>Country</dt>
      <dd>{{ hyp.country ?? '(unknown)' }}</dd>
      <dt>Flag <code>newHero</code></dt>
      <dd data-testid="flag">{{ hyp.flags.newHero ?? false }}</dd>
    </dl>
    <p v-else>Hypdriv did not handle this request.</p>
  </main>
</template>
