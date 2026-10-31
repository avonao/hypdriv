# Prompt: implement Hypdriv on a platform, in production

Paste everything below the line into the chat that owns the platform. Fill the bracketed items first; delete the ones that do not apply.

---

You are implementing Hypdriv in **[PLATFORM / APPLICATION NAME]** for production on Cloudflare. The platform goes live **[WHEN]**. This is production work: no demo build, no MVP, no staging-only shortcut, no deferred part. Everything below is done to the end state.

**Cutover:** [AUTHORIZED: attach the hosts and open the gate once every earlier gate has its evidence | PREPARE ONLY: stop after staging and the cutover rehearsal, and report; the operator pulls the trigger]

## Where the truth is

The Hypdriv release bundle is at **[BUNDLE PATH]**. Work from these files, in this order, and do not rely on memory of Hypdriv, OpenNext or wrangler:

1. `docs/guides/production-cloudflare.md`: read §1–§4 completely before you change anything, then §5 (one app) or §9 (a fleet of area Workers behind a router), then §11 (probes), §12 (launch checklist) and §13 (troubleshooting).
2. `PLATFORMS.md` (private bundles): the section for this platform lists its hosts, Worker and resource names, gate cookies, route lists and the exact deltas. If it contradicts the guide for this platform, `PLATFORMS.md` wins; tell the operator.
3. `templates/`: the files of §5 and §6, ready to copy.
4. `install.sh`: the only way Hypdriv enters the codebase.
5. `fleet/` (fleets only): the generator patch of §9.2 and its reference diff.
6. `platforms/<platform>/` (private bundles): the verified recipe report, the final config files and the change set of a platform that was simulated. Their first block says what this bundle supersedes; re-run their gate steps with this bundle's `install.sh`.

## What to do

1. Install Hypdriv with `install.sh`; commit `vendor/hypdriv/`; confirm the 16 tarballs are tracked.
2. Apply the guide to this codebase: the policy (`hypdriv.config.ts`), `next.config.ts`, the production `open-next.config.ts`, `hypdriv.worker.ts`, the Wrangler config(s), the build and deploy scripts. Keep the platform's own `compatibility_date`, flags, middleware and headers; add only what Hypdriv needs.
3. Review the policy against the platform's real middleware and routes (§6.2–§6.5, §9.3): gate cookies, machine-facing routes, embeds, rate limits, CSP allow-list, HSTS.
4. Provision the Cloudflare resources in the US account (§7.2) and set the secrets (§7.3) without ever printing a value.
5. Build everything on the machine that will deploy it. `hypdriv doctor --ci` must report 0 failed checks.
6. Deploy to staging, run the staging probes, deploy for real, run the zone probes. Populate the R2 cache before every deploy takes traffic (rule 1).
7. Work through the launch checklist (§12) top to bottom and keep a deploy record with the evidence of every row.

## Rules of engagement

- **Production grade only.** If a step needs a new subsystem, build it. Do not stub, defer or shortcut.
- **US first.** Cloudflare resources and accounts are the US ones. EU resources are added next to them only where an EU deployment needs them.
- **Secrets never leave their place.** Do not print, log, paste, copy or commit a secret value, a token or a `.dev.vars` / `.env` / escrow file. Report a secret by name and whether it is present.
- **Do not ask whether to continue.** Take the logical next step. Ask only for what you cannot get yourself: a credential, a permission, a decision between options that are not just more or less of the same implementation, or the cutover when it is not authorized above.
- **No quiet failures.** A gate without evidence is not passed. A failing gate you cannot fix stops the launch for that platform: say which one, with the evidence.
- **Purge through Hypdriv.** A bad cached page is purged with `npx hypdriv purge --url <base> --path … | --tag … | --all` (guide §8.4, probe 12), or by a fresh build and deploy. Cloudflare's purge API alone does not clear Hypdriv's KV tier.
- **Do not edit Hypdriv.** If Hypdriv misbehaves, reproduce it minimally and write it into `HYPDRIV-FEEDBACK.md` in the repository (what you ran, expected, actual, smallest reproduction, no secrets). Work around it only if the guide says how.
- **Keep dependencies fresh.** Apply patch and minor updates; report majors with a safe proposal.

## What to hand back

A short summary, not a narration: what is deployed and where, the checklist with the evidence of each row (or the row that stopped you), the first-deploy items of guide §14 with their outcomes, open risks, and the contents of `HYPDRIV-FEEDBACK.md`.
