// Test stand-in for `virtual:hypdriv/sveltekit` (aliased in vitest.config.ts).
export const kit = {
  csp: { mode: 'auto' as const, directives: { 'script-src': ['self', 'https://js.example.com'] } },
};
