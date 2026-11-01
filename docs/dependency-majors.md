# Major dependency updates: trial results and migration proposal

Patch and minor updates are applied automatically (`hypdriv deps --update safe`, daily in `.github/workflows/dependencies.yml`). Majors are reported with a migration proposal and applied only after review. This page records the open majors as of **2026-11-01** (`hypdriv deps --root .`), each tried in an isolated worktree of `main` with the full gate (`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, 1,543 tests in 156 files).

| Package | In repo | Latest | Where | Trial result | Verdict |
| --- | --- | --- | --- | --- | --- |
| `typescript` | 6.0.3 | 7.0.2 | whole workspace (catalog) | typecheck, lint and tests pass; the build needed one fix, now on `main` | Ready: apply after the CI decision below |
| `vitest` | 4.1.12 | 5.0.5 | whole workspace (catalog) | build, typecheck and all 1,543 tests pass, including the Workers pool | Blocked by the Node baseline (Node 22.12+) |
| `h3` | 1.15.11 | 2.0.8 | `@hypdriv/nuxt` (dev dependency) | not applicable | Do not bump on its own: Nuxt 4.6 runs on Nitro 2 / h3 1.x |

## TypeScript 7.0.2

TypeScript 7 is the native compiler. `tsc` is the new binary and the `typescript` package no longer exposes the old JavaScript compiler API as before; tooling that emits declarations (tsdown through `rolldown-plugin-dts`) switches to `tsgo` and prints "TypeScript 7.0 does not yet have a stable API and is experimental".

**Trial (worktree with `typescript: ^7.0.2` in the catalog):**

- `pnpm typecheck` (all packages, `tsc --noEmit`): passes with no source changes.
- `pnpm lint`: passes (Biome does not use the compiler).
- `pnpm test`: passes (the workspace never imports `typescript` at runtime; tests do not depend on the compiler).
- `pnpm build`: **one failure**, `@hypdriv/sveltekit`: `tsgo did not generate dts file for src/durable-objects.ts`. TypeScript 6 emitted declarations for tsdown's entry files even when the package's `tsconfig.json` excluded them; `tsgo` only emits files that belong to the tsconfig. The Durable Object re-export is excluded on purpose (its sources need `@cloudflare/workers-types`, which the SvelteKit code must not see).

**Fix (already on `main`, works with TypeScript 6 and 7, identical `dist/durable-objects.d.ts`):** the re-export builds from its own program: `packages/sveltekit/tsconfig.durable-objects.json` (Node and Workers types, only that file) as a second entry of `tsdown.config.ts`, plus `@cloudflare/workers-types` as a dev dependency. With it, all 27 builds pass on TypeScript 7.0.2.

**Proposal:**

1. Land the SvelteKit change (done) so the repository builds on both majors.
2. Bump the `typescript` catalog entry to `^7.0.2`, regenerate the lockfile, run the gate on Node 22 and 24.
3. Keep the `@typescript/typescript6` compatibility package in mind for any tool that still needs the JavaScript API (none in this repository today).
4. Expect the tsdown "experimental" warning until tsdown marks TypeScript 7 stable; it does not change the output (compare `dist/**/*.d.ts` between the two compilers when bumping: the SvelteKit entry was byte-identical).
5. Examples and scaffolded apps keep their own TypeScript range (`create-hypdriv` templates use the catalog value at scaffold time): re-run `pnpm -F create-hypdriv test` after the bump.

## Vitest 5.0.5

Vitest 5 raises the baseline to **Node 22.12+ and Vite 6.4+** (Vite is a peer dependency, not bundled), makes `clearMocks` default to `true`, moves the report outputs to `.vitest/`, fails unawaited `expect(...).resolves/.rejects`, removes `sequential`, rewrites the bench API and stops looking for configs in parent directories.

**Trial (worktree with `vitest: ^5.0.5`):** install resolves with no peer warnings; `pnpm build`, `pnpm typecheck` and `pnpm test` pass: 1,543 of 1,543 tests in 156 files, Node and Workers projects (`@cloudflare/vitest-plugin`) included, with no deprecation warnings. The suite uses none of the removed APIs, and every package has its own `vitest.config.ts`.

**Blocker:** `.github/workflows/ci.yml` runs the suite on Node 20, 22 and 24, and the packages declare `engines.node >= 20.9`. Vitest 5 cannot run on Node 20. Node 20 reached end of life in April 2026.

**Proposal (needs a decision on the supported Node baseline):**

1. Decide the baseline. Recommended: Node 22.12+ for development, CI and the documented minimum (`engines.node >= 22.12` on every package), since Node 20 no longer receives security fixes; the runtime code itself stays Web-standard and Workers/Vercel runtimes are unaffected.
2. Update the CI matrix to `[22, 24]`, the `engines` fields, `README.md`, `docs/preview-status.md` ("Node 20 runs the same suite except the vinext build test") and the `hypdriv doctor` Node check.
3. Bump the `vitest` catalog entry to `^5.0.5`; keep `@cloudflare/vitest-plugin` and `@vitest/*` packages in step.
4. Adopt the new defaults: nothing to change for `clearMocks`; add `.vitest/` to `.gitignore`.
5. If Node 20 must stay supported, the alternative is a separate Node 20 job that runs the built tarballs with a pinned Vitest 4; this doubles the test tooling and is not recommended.

## h3 2.0.8

`h3` appears once, as a development dependency of `@hypdriv/nuxt` (types and test doubles for the Nitro plugin: `createError`, `isError`, `readRawBody`, `setResponseStatus`, `H3Event`). The workspace deliberately stays on h3 1.x because Nuxt 4.6 runs on Nitro 2 (`nitropack`), whose request handlers receive h3 v1 events; compiling and testing against h3 v2 types would check the wrong API.

h3 v2 removes `event.node` and `event.web` (`event.req` is a Web `Request`, `event.runtime.node` the Node objects), replaces the `set*/get*Header` helpers with `event.res.headers`, requires handlers to return or throw instead of the `send*` helpers, renames `createError` to `HTTPError`, and `defineEventHandler` to `defineHandler`.

**Proposal:** do not bump `h3` independently. The bump belongs to a Nuxt/Nitro 3 integration: when `@hypdriv/nuxt` supports the Nuxt release that ships on Nitro 3 (h3 v2), add a second runtime entry with the v2 event API (`event.req`, `event.res.headers`) next to the current one and select it from the module by the installed Nuxt version. `hypdriv deps` keeps reporting the major until then.
