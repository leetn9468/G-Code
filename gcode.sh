#!/usr/bin/env bash
# G-Code POSIX Launcher
# O-Research
set -eu

GCODE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GCODE_DIST="$GCODE_ROOT/dist/cli.js"
GCODE_SRC="$GCODE_ROOT/src/cli/cli.ts"

# Prefer built dist if it exists
if [ -f "$GCODE_DIST" ]; then
    if command -v bun >/dev/null 2>&1; then
        exec bun run "$GCODE_DIST" "$@"
    fi
    if command -v node >/dev/null 2>&1; then
        exec node "$GCODE_DIST" "$@"
    fi
fi

# Fall back to source (requires Bun)
if [ -f "$GCODE_SRC" ]; then
    if command -v bun >/dev/null 2>&1; then
        exec bun run "$GCODE_SRC" "$@"
    fi
fi

echo "[G-Code] Error: Neither Bun nor Node.js found." >&2
echo "[G-Code] Install Bun:    brew install oven-sh/bun/bun  # macOS" >&2
echo "[G-Code]                  curl -fsSL https://bun.sh/install | bash  # Linux" >&2
echo "[G-Code] Install Node:   brew install node             # macOS" >&2
exit 1
