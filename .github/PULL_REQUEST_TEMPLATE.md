## What

<!-- One paragraph: what changes and why. Link the issue if there is one. -->

## How

<!-- Design notes a reviewer needs: new stages, config keys, bindings touched, compatibility considerations (Next 16.x, OpenNext, Node vs Workers). -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test` pass
- [ ] Changeset added (`pnpm changeset`) or not needed (internal only)
- [ ] Docs updated (`docs/guides/*`, package README, `docs/feature-catalog.md`)
- [ ] Works on a bare Worker (no optional bindings) and degrades gracefully
- [ ] Security-sensitive? Test demonstrates the prevented attack / regression
