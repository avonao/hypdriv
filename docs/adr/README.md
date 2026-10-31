# Architecture decision records

| #                                      | Decision                                                                        | Status   |
| -------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| [0001](0001-sidecar-not-fork.md)       | Hypdriv is a sidecar that uses only public contracts                            | accepted |
| [0002](0002-adapter-chaining.md)       | Build knowledge comes from a chained Next.js adapter                            | accepted |
| [0003](0003-runtime-artifacts.md)      | Build artifacts are read at run time, never baked into the same build           | accepted |
| [0004](0004-zero-infra-baseline.md)    | Every feature has a zero-infrastructure mode; bindings are upgrades             | accepted |
| [0005](0005-pipeline-model.md)         | One explicit pre/post stage pipeline shared by Worker and proxy                 | accepted |
| [0006](0006-csp-mode-selection.md)     | CSP uses hashes for static routes and nonces for dynamic routes                 | accepted |
| [0007](0007-cache-keys.md)             | Edge cache keys are normalised and include the build id                         | accepted |
| [0008](0008-server-timing-devtools.md) | Server-Timing is the transport for DevTools                                     | accepted |
| [0009](0009-purser-boundary.md)        | Purser is consumed through its build API only                                   | accepted |
| [0010](0010-toolchain.md)              | pnpm + tsdown + vitest + biome; TypeScript 6 in-repo; `source` export condition | accepted |
| [0011](0011-worker-shell.md)           | The Worker entry wraps OpenNext's worker and re-exports its Durable Objects     | accepted |
| [0012](0012-live-channels.md)          | Live features use a Durable Object with hibernation and an SSE/polling fallback | accepted |
| [0013](0013-deploy-targets.md)         | One runtime, three deploy targets: Cloudflare Workers, Vercel and Node hosts    | accepted |
| [0014](0014-scoped-build-artifacts.md) | Restore the classic prerender layout and ship the manifest with every function  | accepted |
| [0015](0015-owner-audit-tokens.md)     | Owner audit tokens let Hypdriv's own tooling through its bot shield              | accepted |
| [0016](0016-deployment-ids-per-build.md) | Deployment ids are unique per build and per app                                 | accepted |
| [0017](0017-purge-consistency.md)      | Edge-cache purges are consistent across isolates, colos and in-flight requests  | accepted |
| [0018](0018-tag-revalidated-prerenders.md) | Prerenders with explicit cache tags are classified `isr`                     | accepted |
| [0019](0019-vite-hosts.md)             | Vite hosts: one runtime and one build engine for every framework                 | accepted |
