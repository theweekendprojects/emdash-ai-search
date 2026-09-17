#!/usr/bin/env bash
#
# local-install.sh — test an unpublished plugin build in the landing page
# using a REAL npm install (packed tarball), not a source copy or workspace link.
#
# This installs exactly what `npm publish` would ship (the `files` allowlist),
# so local testing matches what npm consumers get. No source is copied into the
# consuming site; only the built tarball is installed.
#
# emdash-ai-search is NATIVE-FIRST (smtp model): the default `build` is `tsc`, which
# emits the native descriptor (dist/index.js -> aiSearch()) + runtime (dist/native.js)
# + admin/astro. That's what the site registers via plugins:[aiSearch()]. An optional
# sandboxed bundle (dist/plugin.mjs via `emdash-plugin build`) can be produced
# with AI_SEARCH_WITH_SANDBOX=1, but it is NOT needed for the native/internal path.
#
# Usage:
#   bash scripts/local-install.sh                       # build+pack, install into the default landing page
#   bash scripts/local-install.sh /path/to/consuming-site
#   AI_SEARCH_WITH_SANDBOX=1 bash scripts/local-install.sh     # also build the optional ./sandbox bundle
#
# After running, build/deploy the consuming site to verify:
#   cd <site> && pnpm build      (or pnpm deploy)
#
# Node: the native `tsc` build runs fine on the site's Node (>=22). The site's
# pinned pnpm (>=11) requires Node >= 22.13, so everything runs under Node 22.
# The OPTIONAL sandbox build uses the rolldown bundler, which can hang on Node 22
# here; it is built under Node 20 when AI_SEARCH_WITH_SANDBOX=1.
#
# Requirements: Node >= 22 via nvm (site + native build); pnpm; npm. Node 20 via
# nvm only if you opt into the sandbox build.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SITE_DIR="${1:-$HOME/Documents/GitHub/theweekendprojects-landing-page}"

# Node >= 22 for the native build, pack, and site install (nvm layout). Override
# with NODE22_BIN=/path/to/node22/bin if your version differs.
NODE22_BIN="${NODE22_BIN:-$HOME/.nvm/versions/node/v22.23.2/bin}"

# Node 20 for the OPTIONAL sandbox build only (rolldown bundler hangs on 22 here).
NODE20_BIN="${NODE20_BIN:-$HOME/.nvm/versions/node/v20.18.1/bin}"

[ -d "$SITE_DIR" ] || { echo "ERROR: consuming site not found: $SITE_DIR"; exit 1; }
[ -f "$PLUGIN_DIR/package.json" ] || { echo "ERROR: no package.json in $PLUGIN_DIR"; exit 1; }
[ -d "$NODE22_BIN" ] || { echo "ERROR: Node >=22 not found at $NODE22_BIN (set NODE22_BIN)"; exit 1; }

export PATH="$NODE22_BIN:$PATH"

NAME=$(node -p "require('$PLUGIN_DIR/package.json').name")
VER=$(node -p "require('$PLUGIN_DIR/package.json').version")

cd "$PLUGIN_DIR"
echo "==> Node: $(node -v)"

# 0. Make sure deps are present.
if [ ! -d node_modules ]; then
  echo "==> Installing plugin deps"
  pnpm install
fi

# 1. Native build — the primary artifact set (index.js/native.js/admin.js/astro).
#    NB: invoked as `npx tsc` directly, NOT `pnpm run build`. `pnpm run <script>`
#    hangs on Node 22 in this repo (pnpm-v10-run-script × Node-22 interaction);
#    `npx tsc` on Node 22 is fine.
echo "==> Building $NAME@$VER (native: tsc)"
npx tsc

# 1b. Optional sandbox bundle (./sandbox). Built under Node 20 to avoid the
#     rolldown-on-Node-22 hang. Not needed for the native/internal path.
if [ "${AI_SEARCH_WITH_SANDBOX:-0}" = "1" ]; then
  if [ -d "$NODE20_BIN" ]; then
    echo "==> Building optional sandbox bundle (emdash-plugin build, Node 20)"
    env "PATH=$NODE20_BIN:$PATH" pnpm run build:sandbox
  else
    echo "WARN: AI_SEARCH_WITH_SANDBOX=1 but Node 20 not found at $NODE20_BIN; skipping sandbox build."
  fi
fi

# 2. Pack the plugin into a versioned tarball (exactly what npm would publish).
echo "==> Packing $NAME@$VER from $PLUGIN_DIR"
TARBALL_NAME=$(npm pack 2>/dev/null | tail -1)
TARBALL_PATH="$PLUGIN_DIR/$TARBALL_NAME"
echo "==> Built tarball: $TARBALL_PATH"

# 3. Install the tarball into the consuming site as a normal dependency. pnpm
#    rewrites the dependency to `file:<tarball>` and installs its contents — a
#    real install, no source symlink.
cd "$SITE_DIR"
echo "==> Installing $NAME into $SITE_DIR"
pnpm add "$TARBALL_PATH"

echo
echo "==> Done. $NAME is now installed from the packed tarball."
echo "    Verify with:  cd \"$SITE_DIR\" && pnpm build     (or pnpm deploy)"
echo
echo "NOTE: package.json in the site now points at file:$TARBALL_NAME (local test)."
echo "      To go back to the published npm version, run:"
echo "        cd \"$SITE_DIR\" && pnpm add $NAME@latest"
