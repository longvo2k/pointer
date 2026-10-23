#!/usr/bin/env bash
# Pointer installer — one command, no manual checkout.
#
#   curl -fsSL https://raw.githubusercontent.com/longvo2k/pointer/main/install.sh | bash
#
# Env overrides:
#   POINTER_DIR       install location        (default: ~/.pointer)
#   POINTER_BIN_DIR   where to link binaries  (default: ~/.local/bin)
#   POINTER_REPO      git remote to clone     (default: the public repo)
#   POINTER_REF       tag or branch to install (default: the latest release)
#   POINTER_EDIT_RC=1 add the bin directory to your shell's PATH without asking
#   POINTER_NO_OPEN=1 skip opening Chrome
set -euo pipefail

REPO_URL="${POINTER_REPO:-https://github.com/longvo2k/pointer.git}"
# Install a tagged release, not whatever is on main. POINTER_REF picks another tag or branch.
REF="${POINTER_REF:-}"
INSTALL_DIR="${POINTER_DIR:-$HOME/.pointer}"
BIN_DIR="${POINTER_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

command -v git  >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js 18+ is required (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ is required (found $(node -v))"

if [ -z "$REF" ]; then
  REF="$(git ls-remote --tags --refs --sort=-v:refname "$REPO_URL" 'v*' 2>/dev/null | head -1 | sed 's#.*refs/tags/##')"
  [ -n "$REF" ] || REF=main
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  say "→ updating $INSTALL_DIR to $REF"
  git -C "$INSTALL_DIR" fetch --quiet --depth 1 origin "$REF"
  git -C "$INSTALL_DIR" checkout --quiet --detach FETCH_HEAD
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR exists but is not a Pointer checkout. Move it or set POINTER_DIR."
else
  say "→ cloning Pointer $REF into $INSTALL_DIR"
  git -c advice.detachedHead=false clone --depth 1 --quiet --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
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
      # Never edit a shell file without asking. Under `curl | bash`, stdin is the
      # script, so ask on the terminal; with no terminal, just print the line.
      answer="${POINTER_EDIT_RC:-}"
      if [ -z "$answer" ] && (exec < /dev/tty) 2>/dev/null; then  # a terminal we can really open
        printf '  Add %s to PATH in %s? [y/N] ' "$BIN_DIR" "$RC_FILE" > /dev/tty
        read -r answer < /dev/tty || answer=""
      fi
      case "$answer" in
        y|Y|yes|1)
          printf '\n# Added by Pointer installer\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC_FILE"
          say "  added $BIN_DIR to PATH in $RC_FILE (open a new shell to use it)" ;;
        *)
          say "  $BIN_DIR is not on your PATH. Add this line to $RC_FILE yourself:"
          say "    export PATH=\"$BIN_DIR:\$PATH\"" ;;
      esac
    fi
    export PATH="$BIN_DIR:$PATH"
    ;;
esac

say ""
say "Pointer $REF is installed."
say ""

if [ "${POINTER_NO_OPEN:-0}" = "1" ]; then
  "$BIN_DIR/pointer" setup --no-open
else
  "$BIN_DIR/pointer" setup
fi
