---
"@hypdriv/flags": patch
---

Country and continent rules now match on Vercel and Node: without Cloudflare's `request.cf`, the flags stage reads the platform's geo headers (`x-vercel-ip-country`, `x-vercel-ip-continent`, `x-vercel-ip-country-region`, or `cf-ipcountry` behind a proxy). Previously `hyp().country` was right but rule-based flags stayed at their defaults outside Workers. Found on a live Astro deployment on Vercel.
