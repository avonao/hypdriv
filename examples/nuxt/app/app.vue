<script setup lang="ts">
useHead({
  htmlAttrs: { lang: 'en' },
  link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  style: [
    {
      // An inline style: Nuxt renders it with the request's nonce (dynamic pages) or HypDriv hashes it (prerendered).
      innerHTML:
        'body{font-family:system-ui,sans-serif;margin:0 auto;max-width:44rem;padding:2rem 1rem;line-height:1.5}nav a{margin-right:1rem}code{background:#f3f3f3;padding:0 .25rem}',
    },
  ],
});
</script>

<template>
  <div>
    <nav>
      <NuxtLink to="/">Home</NuxtLink>
      <NuxtLink to="/about">About</NuxtLink>
      <NuxtLink to="/ssr">Request facts</NuxtLink>
      <a href="/api/hello">/api/hello</a>
      <a href="/_hypdriv/health">/_hypdriv/health</a>
    </nav>
    <NuxtPage />
  </div>
</template>
