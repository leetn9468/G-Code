#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

for command_name in bun cargo; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing prerequisite: $command_name. Run ./run.sh first."
    exit 1
  fi
done

if ! cargo tauri --version >/dev/null 2>&1; then
  echo "Missing Tauri CLI v2. Run ./run.sh first."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  bun install --frozen-lockfile
fi

bun run build
cargo tauri build

bundle_dir="$PWD/src-tauri/target/release/bundle"
echo "Build complete. Bundles are in: $bundle_dir"
find "$bundle_dir" -maxdepth 3 -type d -name '*.app' -print 2>/dev/null || true
find "$bundle_dir" -maxdepth 3 -type f -name '*.dmg' -print 2>/dev/null || true
