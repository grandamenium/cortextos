#!/usr/bin/env bash
# AscendOps Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/grandamenium/cortextos/main/installers/ascendops.sh | bash
#
# Installs the AscendOps platform (cortextos engine + ascendops CLI alias)
# on macOS and Linux. Requires Node.js >= 20 and npm.

set -euo pipefail

REPO="https://github.com/grandamenium/cortextos.git"
PACKAGE="cortextos"
BRAND_VAR="ASCENDOPS_BRAND=1"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

header() { echo -e "\n${BOLD}${BLUE}$1${NC}"; }
ok()     { echo -e "  ${GREEN}✓${NC} $1"; }
warn()   { echo -e "  ${YELLOW}⚠${NC}  $1"; }
fail()   { echo -e "  ${RED}✗${NC} $1"; exit 1; }

# ── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║         AscendOps Installer               ║${NC}"
echo -e "${BOLD}║   Persistent 24/7 AI agents for PM teams  ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════╝${NC}"
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────
header "Checking prerequisites"

if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install Node.js >= 20 from https://nodejs.org and re-run."
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "Node.js >= 20 required (found $(node --version)). Please upgrade."
fi
ok "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  fail "npm not found. Install npm and re-run."
fi
ok "npm $(npm --version)"

if ! command -v git &>/dev/null; then
  fail "git not found. Install git and re-run."
fi
ok "git $(git --version | awk '{print $3}')"

# ── Install ───────────────────────────────────────────────────────────────
header "Installing AscendOps"

INSTALL_DIR="$HOME/.ascendops"

if [[ -d "$INSTALL_DIR" ]]; then
  warn "Existing installation found at $INSTALL_DIR — updating"
  cd "$INSTALL_DIR"
  git pull --ff-only origin main 2>/dev/null || {
    warn "git pull failed — doing fresh clone"
    cd ~
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  }
else
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
ok "Repository ready at $INSTALL_DIR"

npm install --silent
ok "Dependencies installed"

npm run build --silent
ok "Build complete"

# ── Link CLI binaries ─────────────────────────────────────────────────────
header "Linking CLI"

NPM_GLOBAL_BIN="$(npm prefix -g)/bin"
LINK_OK=false

if npm link 2>&1 | grep -qv "ERR!" && command -v ascendops &>/dev/null; then
  LINK_OK=true
fi

if [[ "$LINK_OK" == "false" ]]; then
  warn "Global npm link failed (may need sudo). Trying user-local prefix..."
  LOCAL_BIN="$HOME/.local/bin"
  mkdir -p "$LOCAL_BIN"
  if npm link --prefix "$HOME/.local" 2>/dev/null && [[ -f "$LOCAL_BIN/ascendops" ]]; then
    LINK_OK=true
    NPM_GLOBAL_BIN="$LOCAL_BIN"
  fi
fi

if command -v ascendops &>/dev/null; then
  ok "ascendops CLI available: $(which ascendops)"
elif [[ "$LINK_OK" == "true" ]]; then
  warn "ascendops installed to $NPM_GLOBAL_BIN but not in PATH yet."
  warn "Add to your shell profile: export PATH=\"$NPM_GLOBAL_BIN:\$PATH\""
else
  warn "Could not link CLI globally. Run manually:"
  echo "    cd $INSTALL_DIR && sudo npm link"
  echo "  or:"
  echo "    cd $INSTALL_DIR && npm link --prefix \$HOME/.local"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

if command -v cortextos &>/dev/null; then
  ok "cortextos CLI available: $(which cortextos)"
fi

# ── Shell profile setup ───────────────────────────────────────────────────
header "Configuring shell profile"

PROFILE=""
if [[ -f "$HOME/.zshrc" ]]; then
  PROFILE="$HOME/.zshrc"
elif [[ -f "$HOME/.bashrc" ]]; then
  PROFILE="$HOME/.bashrc"
elif [[ -f "$HOME/.bash_profile" ]]; then
  PROFILE="$HOME/.bash_profile"
fi

if [[ -n "$PROFILE" ]]; then
  if ! grep -q "ASCENDOPS_BRAND" "$PROFILE"; then
    echo "" >> "$PROFILE"
    echo "# AscendOps" >> "$PROFILE"
    echo "export $BRAND_VAR" >> "$PROFILE"
    ok "Added ASCENDOPS_BRAND=1 to $PROFILE"
  else
    ok "ASCENDOPS_BRAND already set in $PROFILE"
  fi
else
  warn "Could not detect shell profile. Set manually: export $BRAND_VAR"
fi

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}AscendOps installed!${NC}"
echo ""
echo "  Next steps:"
if [[ -n "${PROFILE:-}" ]]; then
  echo "    1. Reload your shell:  source $PROFILE"
else
  echo "    1. Open a new terminal (or reload your shell profile)"
fi
echo "    2. Set your Anthropic API key: export ANTHROPIC_API_KEY=sk-ant-..."
echo "    3. Create your first org: ascendops init <your-company>"
echo "    4. Add your first agent: ascendops add-agent <name> --template property-management/agent"
echo "    5. Start it: ascendops start <name>"
echo ""
echo "  Documentation: https://github.com/grandamenium/cortextos"
echo ""
