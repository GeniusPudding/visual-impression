#!/usr/bin/env bash
# Install Visual Impression into VS Code on macOS or Linux.
#
# Build from source and hand the result to the VS Code CLI. Re-running is
# safe: --force replaces whatever is installed rather than adding to it.
#
# Over Remote SSH, run this from a terminal INSIDE the VS Code window that is
# connected to the machine. The extension has to live where the terminals it
# watches live, and that integrated terminal is the only place where `code`
# means the server on this host rather than an editor on your laptop.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
EXT_ID="geniuspudding.visual-impression"
MIN_CODE="1.93"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  OK    %s\n' "$*"; }
bad()  { printf '  MISS  %s\n' "$*" >&2; }

find_code() {
  for c in code code-insiders codium cursor; do
    if command -v "$c" >/dev/null 2>&1; then printf '%s' "$c"; return 0; fi
  done
  # Not on PATH: a server installed by Remote SSH keeps its CLI out of the way.
  local c
  c=$(ls -t "$HOME"/.vscode-server/bin/*/bin/remote-cli/code 2>/dev/null | head -1 || true)
  [ -n "$c" ] && { printf '%s' "$c"; return 0; }
  return 1
}

CODE=$(find_code) || { bad "no VS Code CLI found. Over SSH, run this from a terminal inside the connected window."; exit 1; }

# Which half of a Remote SSH session is this? The question people actually
# have is "which machine am I installing on", and the CLI's own path answers
# it: a server installed by Remote SSH keeps its one under ~/.vscode-server.
where_am_i() {
  ok "machine: $(hostname) ($(uname -s) $(uname -m))"
  case "$CODE" in
    *.vscode-server*|*remote-cli*)
      ok "this is the REMOTE half of a Remote SSH session"
      say "        Installing here is right: the terminals, the agents and"
      say "        ~/.codex all live on this machine, not on your laptop."
      ;;
    *)
      ok "this is a local VS Code"
      say "        Installing here covers folders you open locally. Terminals"
      say "        in a Remote SSH window are not these -- install over there too."
      ;;
  esac
}

case "${1:-}" in
  --uninstall)
    "$CODE" --uninstall-extension "$EXT_ID" || true
    say "Removed $EXT_ID. Your history in ~/.wt-tabs/vscode/ was left alone."
    exit 0
    ;;
  --check)
    say ''
    say "Visual Impression  $ROOT"
    where_am_i
    command -v node >/dev/null 2>&1 && ok "node $(node --version)" || bad 'node not found (18 or newer)'
    command -v npm  >/dev/null 2>&1 && ok "npm  $(npm --version)"  || bad 'npm not found'
    ok "VS Code CLI: $CODE ($("$CODE" --version 2>/dev/null | head -1))"
    if "$CODE" --list-extensions 2>/dev/null | grep -qx "$EXT_ID"; then
      ok "$EXT_ID installed"
    else
      bad "$EXT_ID not installed (run this script with no arguments)"
    fi
    # The real question on a new platform is whether the process table can be
    # read here at all, and that is what the live tests answer.
    if [ -d "$ROOT/node_modules" ]; then
      say ''
      say 'tests'
      npm test --prefix "$ROOT"
    else
      say ''
      say 'run the installer first to fetch dependencies, then --check runs the tests'
    fi
    exit 0
    ;;
esac

command -v npm >/dev/null 2>&1 || { bad 'npm not found; install Node 18 or newer first'; exit 1; }

have=$("$CODE" --version 2>/dev/null | head -1 || echo 0)
if [ "$(printf '%s\n%s\n' "$MIN_CODE" "$have" | sort -V | head -1)" != "$MIN_CODE" ]; then
  bad "VS Code $have is older than $MIN_CODE; the shell integration API this needs is not there yet"
  exit 1
fi

say ''
say "Installing Visual Impression from $ROOT"
npm install --no-audit --no-fund --silent
npm test
npx --yes vsce package --no-dependencies
VSIX=$(ls -t ./*.vsix | head -1)
"$CODE" --install-extension "$VSIX" --force
ok "installed $(basename "$VSIX") with $CODE"
say ''
say 'Reload the window (Developer: Reload Window) and it starts recording.'
say 'Verify any time with:  ./scripts/setup.sh --check'
say ''
