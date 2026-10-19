#!/usr/bin/env bash
# Pointer installer — one command, no manual checkout.
#
#   curl -fsSL https://raw.githubusercontent.com/longvo2k/pointer/main/install.sh | bash
#
# Env overrides:
#   POINTER_DIR       install location        (default: ~/.pointer)
#   POINTER_BIN_DIR   where to link binaries  (default: ~/.local/bin)
#   POINTER_REPO      git remote to clone     (default: the public repo)
#   POINTER_NO_OPEN=1 skip opening Chrome
set -euo pipefail

REPO_URL="${POINTER_REPO:-https://github.com/longvo2k/pointer.git}"
INSTALL_DIR="${POINTER_DIR:-$HOME/.pointer}"
BIN_DIR="${POINTER_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

command -v git  >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js 18+ is required (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ is required (found $(node -v))"

if [ -d "$INSTALL_DIR/.git" ]; then
  say "→ updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only --quiet
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR exists but is not a Pointer checkout. Move it or set POINTER_DIR."
else
  say "→ cloning Pointer into $INSTALL_DIR"
  git clone --depth 1 --quiet "$REPO_URL" "$INSTALL_DIR"
fi

say "→ installing dependencies"
if [ -f "$INSTALL_DIR/package-lock.json" ]; then
  npm --prefix "$INSTALL_DIR" ci --omit=dev --no-audit --no-fund --silent
else
  npm --prefix "$INSTALL_DIR" install --omit=dev --no-audit --no-fund --silent
fi

say "→ linking commands into $BIN_DIR"
mkdir -p "$BIN_DIR"
chmod +x "$INSTALL_DIR/bin/pointer.mjs" "$INSTALL_DIR/bin/mcp.mjs"
ln -sf "$INSTALL_DIR/bin/pointer.mjs" "$BIN_DIR/pointer"
ln -sf "$INSTALL_DIR/bin/mcp.mjs" "$BIN_DIR/pointer-mcp"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    SHELL_NAME="$(basename "${SHELL:-}")"
    case "$SHELL_NAME" in
      zsh)  RC_FILE="$HOME/.zshrc" ;;
      bash) RC_FILE="$HOME/.bash_profile"; [ -f "$HOME/.bashrc" ] && RC_FILE="$HOME/.bashrc" ;;
      *)    RC_FILE="" ;;
    esac
    if [ -n "$RC_FILE" ] && ! grep -q "Added by Pointer installer" "$RC_FILE" 2>/dev/null; then
      printf '\n# Added by Pointer installer\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC_FILE"
      say "  added $BIN_DIR to PATH in $RC_FILE (open a new shell to use it)"
    fi
    export PATH="$BIN_DIR:$PATH"
    ;;
esac

say ""
say "Pointer is installed."
say ""

if [ "${POINTER_NO_OPEN:-0}" = "1" ]; then
  "$BIN_DIR/pointer" setup --no-open
else
  "$BIN_DIR/pointer" setup
fi
