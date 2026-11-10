#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

confirm_install() {
  local prerequisite="$1"
  printf '%s is required but was not found. Install it now? [y/N] ' "$prerequisite"
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "G-Code Desktop currently supports macOS arm64 only."
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  if confirm_install "Xcode Command Line Tools"; then
    xcode-select --install
    echo "Finish the Apple installer, then run this script again."
  fi
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  if confirm_install "Bun"; then
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
  else
    exit 1
  fi
fi

if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

if ! command -v rustup >/dev/null 2>&1; then
  if confirm_install "Rust (via rustup)"; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  else
    exit 1
  fi
fi

if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust was installed, but cargo is unavailable. Restart your terminal and retry."
  exit 1
fi

if ! cargo tauri --version >/dev/null 2>&1; then
  if confirm_install "Tauri CLI v2 for Cargo"; then
    cargo install tauri-cli --version '^2' --locked
  else
    exit 1
  fi
fi

if [[ ! -d node_modules ]]; then
  bun install --frozen-lockfile
fi

exec cargo tauri dev
