---
'@hypdriv/core': minor
'@hypdriv/purser': minor
'@hypdriv/next': minor
---

Purser 0.2: `purser.names` (`legacy`, `short`, `min`), `granularity`, `minify`, `fuse`, `namesFile` and `compile` in `hypdriv.config.ts`. With `compile` (on by default with `names: 'min'`), `withHypDriv` gives Turbopack and webpack Purser's loader, with the naming options and the names file of the stylesheet build, so modules are compiled and the browser runs no style code (`applyPurserCompiler`, `PURSER_COMPILE_GLOB`; `PurserBridge.compile`, `purserLoaderOptions`, `purserTwoOptions`, `versionAtLeast` in `@hypdriv/purser/node`). The unstyled-atom guard, the atom usage report and the stylesheet analysis know the naming in use (`AtomNaming`, `atomNaming`, `atomClassPattern`): with minimal names every class in the atoms layer is an atom. Purser 0.2 brings its own parser, so a project on TypeScript 7 needs no TypeScript 6 alias; options that need 0.2 stop the build with the option's name when 0.1 is installed.
