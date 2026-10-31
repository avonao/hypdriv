# HypDriv release bundle {{VERSION}} ({{DATE}})

HypDriv is not on npm. This folder is everything an application needs to install it, configure it for production on Cloudflare and go live. Built from commit `{{COMMIT}}`.

## Start here

1. Read `docs/guides/production-cloudflare.md` (the implementation guide): §1–§4 completely, then §5 (one app, one Worker) or §9 (a fleet of area Workers behind a router), then §11 (probes), §12 (launch checklist) and §13 (troubleshooting).
2. Install: `./install.sh <app root>`. It verifies `SHA256SUMS`, copies the 16 tarballs a Next.js app needs into `<app root>/vendor/hypdriv/` and runs `npm install --save` on them. Commit `vendor/hypdriv/`.
3. Copy the files in `templates/` into the app and fill the placeholders (`<app>`, `<host>`, resource ids). They are the code blocks of the guide, extracted at build time, so they cannot drift from it.
4. Work through the launch checklist (§12). Every row asks for evidence; collect it in the deploy record.

## Contents

| Path | What it is |
| --- | --- |
| `VERSION` | The version of every tarball in this bundle (`{{VERSION}}`). |
| `SHA256SUMS` | Checksums of every tarball (`cd tarballs && shasum -a 256 -c ../SHA256SUMS`). |
| `tarballs/` | {{TARBALLS}} packed packages. A Next.js app installs 16 of them (the umbrella `hypdriv` and 15 `@hypdriv/*`); the rest are Vite-host integrations. Never install all of them at once. |
| `install.sh` | The verified installer. Also the updater: run a newer bundle's `install.sh` against the same app. |
| `templates/` | `hypdriv.config.ts`, `next.config.ts`, `open-next.config.ts`, `hypdriv.worker.ts`, `wrangler.jsonc`, `dev.vars.example`. |
| `docs/` | The HypDriv docs as of this commit; the implementation guide is `docs/guides/production-cloudflare.md`. |
| `skills/hypdriv/` | The HypDriv skill for coding agents. |
| `AGENTS.md` | Posture and conventions for agents working on HypDriv itself. |
| `PROMPT-FOR-CHATS.md` | The prompt to paste into a chat that has to implement this. |

A private bundle may also carry `PLATFORMS.md` (hosts, names and deltas of each platform), `fleet/` (the generator patch of guide §9.2 and a reference diff) and `platforms/<platform>/` (the simulation reports, final config files and change sets of single-app platforms). They are not part of the open-source repository.

## Rules that matter most

The guide's §2 lists all seventeen. These five end launches:

- **Populate the R2 cache before the first request** (`opennextjs-cloudflare populateCache remote --config <wrangler file>`), on every deploy, before `wrangler deploy`.
- **`middleware.ts` present ⇒ `hypdriv init --no-proxy`.**
- **`cache.edge.bypass` lists every cookie or header the middleware gates on.**
- **Secrets are set before the first request** and are never printed, copied or committed.
- **Install from this bundle only**, all tarballs from one bundle.

## Updating

Bundles are immutable. A new bundle is a new folder. Run its `install.sh` against the app, rebuild, run `npx hypdriv doctor --ci`, redeploy (populate first). Read the guide's §8.3–§8.6 for the after-deploy checks and rollback. A bad cached page is purged with `npx hypdriv purge` (guide §8.4, probe 12), not with Cloudflare's purge API alone.

## Reporting a defect

Write what you ran, what you expected, what happened, and the smallest reproduction you can produce (a config, a request, the doctor JSON). Do not paste secrets or customer data. Put it in `HYPDRIV-FEEDBACK.md` in the application repository so it can be carried back to HypDriv.
