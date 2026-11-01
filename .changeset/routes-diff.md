---
"@hypdriv/cli": minor
---

`hypdriv routes --diff <manifest>` compares the build with the manifest of an earlier build (a `manifest.json`, or a directory holding `.hypdriv/manifest.json`) and reports routes that became more dynamic (`static` → `isr` → `shell` → `dynamic`), lost their hash CSP, edge cache policy or prerendered paths, plus improvements, added and removed routes; `--weights` adds client JS/CSS growth (`--weight-threshold`). It exits 1 on regressions (`--fail-on regress|change|never`) and prints JSON with `--json`, so a pull request can fail on an accidental dynamic opt-in.
