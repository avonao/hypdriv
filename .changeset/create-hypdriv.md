---
"create-hypdriv": minor
---

Implement the scaffolder: `create-hypdriv [directory] --platform cloudflare|vercel [--purser] [--pm …] [--name …] [--no-install] [--no-git] [--yes] [--json]`, with prompts on a TTY. Templates are the repository's audited example apps (`cloudflare`, `cloudflare-purser`, `vercel`, `vercel-purser`), synced at build time with pinned dependency versions. The scaffolder generates local secrets (`.dev.vars` / `.env.local`), names the Worker, service binding, R2 bucket and Analytics Engine dataset after the project, sets a current compatibility date, allows the needed install scripts for pnpm, installs dependencies and creates the initial commit. A programmatic API (`scaffold`, `syncTemplates`, …) is exported.
