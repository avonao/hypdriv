<script lang="ts">
let { children } = $props();
</script>

<header>
  <nav>
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/blog/hello-world">Blog</a>
    <a href="/ssr">Request facts</a>
    <a href="/form">Form</a>
  </nav>
</header>

<main>
  {@render children()}
</main>

<style>
  :global(body) {
    font-family: system-ui, sans-serif;
    margin: 0 auto;
    max-width: 48rem;
    padding: 1.5rem;
    line-height: 1.5;
  }
  nav {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
</style>
