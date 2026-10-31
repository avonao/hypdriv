---
"@hypdriv/security": patch
"@hypdriv/cli": patch
---

Documents carrying a per-request CSP nonce get `Cache-Control: private, no-cache` when the application sent no caching policy (framework SSR responses often have none), so no shared cache stores a nonce. The audit no longer expects a CSP on API endpoints or JSON responses (`endpoint` routes, non-HTML content types).
