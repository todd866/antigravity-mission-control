#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_ROOT/launchd/agy-control-api.plist.template"
LABEL="${AGY_CONTROL_LABEL:-local.agy-control-api}"
PORT="${AGY_CONTROL_PORT:-8696}"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="$HOME/.local/state/agy-control"
TOKEN_PATH="$STATE_DIR/token"

pick_node() {
  if [[ -n "${AGY_NODE_BIN:-}" && -x "${AGY_NODE_BIN}" ]]; then
    printf '%s\n' "$AGY_NODE_BIN"
    return 0
  fi
  local candidates=()
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  local nvm_cand
  while IFS= read -r nvm_cand; do
    candidates+=("$nvm_cand")
  done < <(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV || true)
  [[ -x /opt/homebrew/bin/node ]] && candidates+=(/opt/homebrew/bin/node)
  [[ -x /usr/local/bin/node ]] && candidates+=(/usr/local/bin/node)

  local cand major
  for cand in "${candidates[@]}"; do
    [[ -x "$cand" ]] || continue
    major="$("$cand" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
    if [[ "$major" -ge 22 ]]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(pick_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "agy-control-api requires Node.js 22 or newer." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR"
if [[ ! -f "$TOKEN_PATH" ]]; then
  umask 077
  openssl rand -hex 32 > "$TOKEN_PATH"
  chmod 600 "$TOKEN_PATH"
  echo "Generated bearer token at $TOKEN_PATH"
fi

sed \
  -e "s|__LABEL__|$LABEL|g" \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__NODE_DIR__|$NODE_DIR|g" \
  -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__PORT__|$PORT|g" \
  "$TEMPLATE" > "$PLIST_DST"

UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"
echo "Loaded LaunchAgent $LABEL on 127.0.0.1:$PORT ($PLIST_DST)"
echo "If remote Focus/Stop/Send returns Accessibility errors, allow $NODE_BIN in System Settings > Privacy & Security > Accessibility."
