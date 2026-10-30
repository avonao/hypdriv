---
"@hypdriv/next": minor
"@hypdriv/cloudflare": patch
"@hypdriv/cli": patch
---

Deployment ids are unique per build and per app (ADR 0016). `defaultDeploymentId()` returns `<commit>-<build stamp>` and shares it with every process of the build through `__HYPDRIV_BUILD_DEPLOYMENT_ID`; `HYPDRIV_DEPLOYMENT_ID` is used verbatim (sanitised, at most 64 characters). Next.js 16 uses a constant `BUILD_ID` whenever a deployment id is set and OpenNext keys its incremental, regional and tag caches by the deployment id, so two apps built from one commit and deployed to one zone served each other's pages (found on a live account). `x-hypdriv-build`, `/_hypdriv/health` (`build`, `deployment`) and the Worker's startup log report the content fingerprint and the deployment id instead of Next's constant build id. `hypdriv doctor` warns about a constant `performance.skewProtection.deploymentId`.
