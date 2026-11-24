#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/plugin"
PLUGIN_DST="${AGY_PLUGIN_DIR:-$HOME/.gemini/config/plugins/mission-control}"

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
  echo "Mission Control requires Node.js 22 or newer (for node:sqlite)." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
NPM_BIN="$NODE_DIR/npm"

mkdir -p "$PLUGIN_DST/src" "$PLUGIN_DST/assets"
cp -f "$PLUGIN_SRC/plugin.json" "$PLUGIN_SRC/package.json" "$PLUGIN_SRC/package-lock.json" \
  "$PLUGIN_SRC/build.mjs" "$PLUGIN_SRC/server.mjs" "$PLUGIN_DST/"
cp -f "$PLUGIN_SRC/assets/logo.svg" "$PLUGIN_DST/assets/"
cp -f "$PLUGIN_SRC/src/"* "$PLUGIN_DST/src/"

cat > "$PLUGIN_DST/mcp_config.json" <<EOF
{
  "mcpServers": {
    "board": {
      "command": "$NODE_BIN",
      "args": ["\${PLUGIN_ROOT}/server.mjs", "--data_dir=\${PLUGIN_DATA}"],
      "env": {
        "PATH": "$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        "HOME": "$HOME"
      }
    }
  }
}
EOF

if [[ ! -d "$PLUGIN_DST/node_modules" ]]; then
  echo "Installing plugin dependencies in $PLUGIN_DST..."
  (cd "$PLUGIN_DST" && PATH="$NODE_DIR:$PATH" "$NPM_BIN" ci --no-audit --no-fund)
fi

(cd "$PLUGIN_DST" && PATH="$NODE_DIR:$PATH" "$NPM_BIN" run build)
echo "Installed and built Mission Control plugin at $PLUGIN_DST"
