#!/usr/bin/env bash
# install.sh <app root>
#
# Installs Hypdriv from this release bundle into a Node application: verifies the checksums, copies the 16 tarballs the
# application needs into <app root>/vendor/hypdriv/, and runs `npm install --save` on them. Safe to run again with the
# tarballs of a newer bundle: tarballs of the same version are not re-read by npm ("up to date"), so the Hypdriv entries
# are cleared from node_modules and from package-lock.json first (every other lock entry is kept).
#
# Nothing is fetched from a registry for Hypdriv itself (it is not on npm). Needs: bash, node >= 22.18, npm >= 10, and
# shasum or sha256sum. See docs/guides/production-cloudflare.md section 4.
set -euo pipefail

BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${1:-}"
[ -n "$APP" ] && [ -d "$APP" ] || { echo "usage: install.sh <app root>   (a directory with a package.json)" >&2; exit 2; }
APP="$(cd "$APP" && pwd)"
[ -f "$APP/package.json" ] || { echo "install.sh: $APP/package.json not found" >&2; exit 2; }
VERSION="$(tr -d '[:space:]' < "$BUNDLE/VERSION")"
# The umbrella package first, then the 15 packages an application needs. The Vite-host packages (vite, astro, ...) are not
# installed for a Next.js application, and installing all 25 tarballs fails on a vinext peer conflict.
NAMES=(hypdriv-core hypdriv-build hypdriv-runtime hypdriv-cache hypdriv-security hypdriv-observe hypdriv-purser hypdriv-flags hypdriv-live hypdriv-image hypdriv-devtools hypdriv-vercel hypdriv-cloudflare hypdriv-next hypdriv-cli)
FILES=("hypdriv-$VERSION.tgz")
for n in "${NAMES[@]}"; do FILES+=("$n-$VERSION.tgz"); done

command -v node >/dev/null || { echo "install.sh: node not found" >&2; exit 1; }
command -v npm >/dev/null || { echo "install.sh: npm not found" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<18)) { console.error("install.sh: warning: Node "+process.versions.node+" < 22.18; hypdriv.config.ts is loaded with native type stripping, use Node 22.18+ or 24"); }'

echo "== checksums"
if command -v shasum >/dev/null; then SUM=(shasum -a 256 -c); else SUM=(sha256sum -c); fi
(cd "$BUNDLE/tarballs" && "${SUM[@]}" ../SHA256SUMS >/dev/null) || { echo "install.sh: checksum mismatch: the bundle is damaged, do not install" >&2; exit 1; }
for f in "${FILES[@]}"; do [ -f "$BUNDLE/tarballs/$f" ] || { echo "install.sh: tarballs/$f is missing" >&2; exit 1; }; done
echo "ok"

echo "== copy to $APP/vendor/hypdriv"
mkdir -p "$APP/vendor/hypdriv"
# Tarballs of an older bundle go; the application installs exactly this bundle's set.
find "$APP/vendor/hypdriv" -maxdepth 1 -name 'hypdriv-*.tgz' -type f -delete
for f in "${FILES[@]}"; do cp "$BUNDLE/tarballs/$f" "$APP/vendor/hypdriv/$f"; done
if git -C "$APP" rev-parse --git-dir >/dev/null 2>&1 && git -C "$APP" check-ignore -q "vendor/hypdriv/hypdriv-$VERSION.tgz"; then
  echo "install.sh: warning: git ignores vendor/hypdriv/*.tgz; CI cannot install Hypdriv unless you commit them (git add -f)" >&2
fi

echo "== clear previous Hypdriv entries (node_modules and package-lock.json)"
rm -rf "$APP/node_modules/hypdriv" "$APP/node_modules/@hypdriv"
if [ -f "$APP/package-lock.json" ]; then
  APP="$APP" node -e '
    const fs = require("fs"), path = require("path");
    const file = path.join(process.env.APP, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    let removed = 0;
    for (const k of Object.keys(lock.packages ?? {})) {
      if (k === "node_modules/hypdriv" || k.startsWith("node_modules/@hypdriv/") || k.includes("/node_modules/@hypdriv/") || k.includes("/node_modules/hypdriv")) { delete lock.packages[k]; removed++; }
    }
    // lockfileVersion 1 style trees are not written by npm >= 7; nothing to do for them.
    fs.writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
    console.log("removed " + removed + " lock entries");
  '
fi

echo "== npm install"
ARGS=()
for f in "${FILES[@]}"; do ARGS+=("vendor/hypdriv/$f"); done
(cd "$APP" && npm install --save --no-audit --no-fund "${ARGS[@]}")

echo "== verify"
APP="$APP" VERSION="$VERSION" node -e '
  const path = require("path");
  const need = ["hypdriv", ...process.argv.slice(1).map((n) => n.replace(/^hypdriv-/, "@hypdriv/"))];
  const bad = [];
  for (const n of need) {
    try {
      const v = require(path.join(process.env.APP, "node_modules", n, "package.json")).version;
      if (v !== process.env.VERSION) bad.push(n + "@" + v);
    } catch { bad.push(n + " (missing)"); }
  }
  if (bad.length) { console.error("install.sh: not installed as expected: " + bad.join(", ")); process.exit(1); }
  console.log("hypdriv " + process.env.VERSION + " and " + (need.length - 1) + " @hypdriv packages installed");
' "${NAMES[@]}"
echo "done. Next: docs/guides/production-cloudflare.md section 5 (one app) or 9 (a fleet)."
