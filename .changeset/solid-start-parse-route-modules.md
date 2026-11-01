---
'@hypdriv/solid-start': patch
---

Route modules are now read with Vite's parser (TypeScript and JSX) instead of a regex scan over text with comments and strings blanked: an apostrophe in JSX text, a regular expression with a quote or a nested template literal can no longer hide `export default` or an HTTP handler, and every declarator of `export const a = 1, b = 2` and destructured exports are found. A module the parser rejects falls back to a lexical read that now understands regular expressions and template interpolations.
