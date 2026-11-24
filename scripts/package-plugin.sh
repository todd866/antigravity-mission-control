#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/plugin"
DIST_OUT="$REPO_ROOT/dist"

VERSION="$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('$PLUGIN_SRC/plugin.json','utf8')).version || '1.2.0')")"
ZIP_NAME="mission-control-plugin-v${VERSION}.zip"
ZIP_PATH="$DIST_OUT/$ZIP_NAME"
MARKETPLACE_PATH="$DIST_OUT/marketplace.json"

mkdir -p "$DIST_OUT"

if [[ ! -d "$PLUGIN_SRC/node_modules" ]]; then
  echo "Installing plugin dependencies in $PLUGIN_SRC..."
  (cd "$PLUGIN_SRC" && npm ci --no-audit --no-fund)
fi

(cd "$PLUGIN_SRC" && npm run build)

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

mkdir -p "$STAGE_DIR/assets" "$STAGE_DIR/bin" "$STAGE_DIR/dist"
cp -f "$PLUGIN_SRC/plugin.json" "$STAGE_DIR/"
cp -f "$PLUGIN_SRC/assets/logo.svg" "$STAGE_DIR/assets/"
cp -f "$REPO_ROOT/README.md" "$STAGE_DIR/README.md"
cp -f "$PLUGIN_SRC/dist/app.html" "$PLUGIN_SRC/dist/server.mjs" "$STAGE_DIR/dist/"

cat > "$STAGE_DIR/bin/launch.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
export PATH="$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

exec "$NODE_BIN" "$PLUGIN_ROOT/dist/server.mjs" "$@"
EOF
chmod +x "$STAGE_DIR/bin/launch.sh"

cat > "$STAGE_DIR/mcp_config.json" <<'EOF'
{
  "mcpServers": {
    "board": {
      "command": "bash",
      "args": ["${PLUGIN_ROOT}/bin/launch.sh", "--data_dir=${PLUGIN_DATA}"]
    }
  }
}
EOF

(cd "$STAGE_DIR" && zip -qr "$STAGE_DIR/$ZIP_NAME" .)
mv -f "$STAGE_DIR/$ZIP_NAME" "$ZIP_PATH"
SHA256="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"

cat > "$MARKETPLACE_PATH" <<EOF
{
  "name": "todd866-plugins",
  "plugins": [
    {
      "name": "mission-control",
      "version": "${VERSION}",
      "description": "Pictorial instrument cockpit, turn-aware AI briefings, adaptive AI Commander, and multi-Mac federation for Antigravity.",
      "source": {
        "source": "url",
        "url": "https://github.com/todd866/antigravity-mission-control/releases/download/v${VERSION}/${ZIP_NAME}",
        "sha256": "${SHA256}"
      }
    }
  ]
}
EOF

echo "Packaged: $ZIP_PATH (sha256: $SHA256)"
echo "Marketplace manifest: $MARKETPLACE_PATH"

if command -v agy >/dev/null 2>&1; then
  agy plugin validate --strict "$PLUGIN_SRC"
  agy plugin validate --strict "$ZIP_PATH"
  if [[ "${1:-}" == "--validate-remote" ]]; then
    agy plugin validate --strict "$MARKETPLACE_PATH"
  else
    echo "Ready: publish v${VERSION} release with $ZIP_PATH & $MARKETPLACE_PATH, then run 'agy plugin validate --strict $MARKETPLACE_PATH'."
  fi
fi
