<script setup lang="ts">
// Prerendered (`routeRules: { '/': { prerender: true } }`): the document is static, so its CSP uses the hashes
// Hypdriv computed at build time and its headers come from `_headers` / Vercel's `config.json`.
useHead({ title: 'Hypdriv for Nuxt' });
</script>

<template>
  <main>
    <h1>Hypdriv for Nuxt</h1>
    <p>
      This page was prerendered at build time. Hypdriv hashed its inline scripts into the page's
      <code>Content-Security-Policy</code>; the platform serves it with the static header rules the build wrote.
    </p>
    <p>
      <NuxtLink to="/ssr">Request facts</NuxtLink> renders per request: its CSP uses a nonce that Nuxt stamps on every
      script it renders.
    </p>
  </main>
</template>
