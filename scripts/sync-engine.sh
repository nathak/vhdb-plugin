#!/bin/sh
# usage: scripts/sync-engine.sh <vhdb repo> <vhdb.wasm>
# Copies the host (vhdb.mjs) and the built wasm into engine/ and records where they came from.
set -eu
repo=${1:?vhdb repo}; wasm=${2:?vhdb.wasm}
here=$(cd "$(dirname "$0")/.." && pwd)
cp "$repo/crates/vhdb-wasm/js/vhdb.mjs" "$here/engine/vhdb.mjs"
cp "$wasm" "$here/engine/vhdb.wasm"
{
  echo "vhdb commit: $(git -C "$repo" rev-parse HEAD)"
  echo "built with: zig cc wrapper (not reproducible CI build)"
  (cd "$here/engine" && sha256sum vhdb.mjs vhdb.wasm)
} > "$here/engine/SOURCE"
cat "$here/engine/SOURCE"
