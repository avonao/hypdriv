---
'@hypdriv/purser': minor
---

Implement the Purser CSS bridge: `themeStage` with edge `<html>` pinning (HTMLRewriter) and client-hint negotiation, the deterministic hashed fallback script (`buildThemeScript`, `themeScriptHash`, `themeScriptTag`), `layerStatement` for adopting Purser next to existing CSS, stylesheet/HTML atom analysis (`extractAtomClasses`, `extractHtmlClasses`, `verifyAtoms`), and the Node tooling: `detectPurser` (with the TypeScript 7 / `@typescript/typescript6` hint), `createPurserBridge` (in-process `build`/`check`/`watch` with one shared watcher per process and `.hypdriv/dev/purser.json` diagnostics), `verifyBuild` (the unstyled-atom guard producing the manifest's `purser` section), `collectPrerenderedHtml`, and `auditOverrides` (headless Chrome over CDP running Purser's `strike-count.js`).
