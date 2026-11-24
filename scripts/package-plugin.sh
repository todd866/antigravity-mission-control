#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/plugin"
DIST_OUT="$REPO_ROOT/dist"

VERSION="$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('$PLUGIN_SRC/plugin.json','utf8')).version || '1.2.0')")"
ZIP_NAME="mission-control-plugin-v${VERSION}.zip"
ZIP_PATH="$DIST_OUT/$ZIP_NAME"
MCPB_NAME="mission-control-v${VERSION}.mcpb"
MCPB_PATH="$DIST_OUT/$MCPB_NAME"
ROOT_MARKETPLACE="$REPO_ROOT/marketplace.json"
DIST_MARKETPLACE="$DIST_OUT/marketplace.json"
ROOT_SERVER_JSON="$REPO_ROOT/server.json"
RELEASE_BASE="https://github.com/todd866/antigravity-mission-control/releases/download/v${VERSION}"

mkdir -p "$DIST_OUT"

if [[ ! -d "$PLUGIN_SRC/node_modules" ]]; then
  echo "Installing plugin dependencies in $PLUGIN_SRC..."
  (cd "$PLUGIN_SRC" && npm ci --no-audit --no-fund)
fi

(cd "$PLUGIN_SRC" && npm run build)

STAGE_PLUGIN="$(mktemp -d)"
STAGE_MCPB="$(mktemp -d)"
trap 'rm -rf "$STAGE_PLUGIN" "$STAGE_MCPB"' EXIT

# 1. Stage standalone Antigravity plugin (.zip)
mkdir -p "$STAGE_PLUGIN/assets" "$STAGE_PLUGIN/bin" "$STAGE_PLUGIN/dist"
cp -f "$PLUGIN_SRC/plugin.json" "$STAGE_PLUGIN/"
cp -f "$PLUGIN_SRC/assets/logo.svg" "$STAGE_PLUGIN/assets/"
cp -f "$REPO_ROOT/README.md" "$STAGE_PLUGIN/README.md"
cp -f "$PLUGIN_SRC/dist/app.html" "$PLUGIN_SRC/dist/server.mjs" "$STAGE_PLUGIN/dist/"

cat > "$STAGE_PLUGIN/bin/launch.sh" <<'EOF'
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
chmod +x "$STAGE_PLUGIN/bin/launch.sh"

cat > "$STAGE_PLUGIN/mcp_config.json" <<'EOF'
{
  "mcpServers": {
    "board": {
      "command": "bash",
      "args": ["${PLUGIN_ROOT}/bin/launch.sh", "--data_dir=${PLUGIN_DATA}"]
    }
  }
}
EOF

(cd "$STAGE_PLUGIN" && zip -qr "$STAGE_PLUGIN/$ZIP_NAME" .)
mv -f "$STAGE_PLUGIN/$ZIP_NAME" "$ZIP_PATH"
ZIP_SHA256="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"

# 2. Stage standalone MCP Bundle (.mcpb)
mkdir -p "$STAGE_MCPB/assets" "$STAGE_MCPB/dist"
cp -f "$PLUGIN_SRC/assets/logo.svg" "$STAGE_MCPB/assets/"
cp -f "$REPO_ROOT/README.md" "$STAGE_MCPB/README.md"
cp -f "$PLUGIN_SRC/dist/app.html" "$PLUGIN_SRC/dist/server.mjs" "$STAGE_MCPB/dist/"

python3 - "$STAGE_MCPB/manifest.json" "$VERSION" <<'PY'
import json, pathlib, sys
out, version = pathlib.Path(sys.argv[1]), sys.argv[2]
out.write_text(json.dumps({
    "manifest_version": "0.3",
    "name": "antigravity-mission-control",
    "display_name": "Mission Control for Antigravity",
    "version": version,
    "description": "Pictorial instrument cockpit, turn-aware AI briefings, adaptive AI Commander, and multi-Mac federation for Antigravity.",
    "author": {
        "name": "Ian Todd",
        "url": "https://github.com/todd866"
    },
    "repository": {
        "type": "git",
        "url": "https://github.com/todd866/antigravity-mission-control"
    },
    "homepage": "https://github.com/todd866/antigravity-mission-control",
    "license": "MIT",
    "icon": "assets/logo.svg",
    "server": {
        "type": "node",
        "entry_point": "dist/server.mjs",
        "mcp_config": {
            "command": "node",
            "args": ["${__dirname}/dist/server.mjs"]
        }
    }
}, indent=2) + "\n", encoding="utf-8")
PY

(cd "$STAGE_MCPB" && zip -qr "$STAGE_MCPB/$MCPB_NAME" .)
mv -f "$STAGE_MCPB/$MCPB_NAME" "$MCPB_PATH"
MCPB_SHA256="$(shasum -a 256 "$MCPB_PATH" | awk '{print $1}')"

# 3. Generate verified marketplace.json & server.json with exact SHA-256 digests
python3 - "$ROOT_MARKETPLACE" "$DIST_MARKETPLACE" "$ROOT_SERVER_JSON" "$VERSION" "$RELEASE_BASE" "$ZIP_NAME" "$ZIP_SHA256" "$MCPB_NAME" "$MCPB_SHA256" <<'PY'
import json, pathlib, sys
root_mp, dist_mp, srv_path = map(pathlib.Path, sys.argv[1:4])
version, rel_base, zip_name, zip_sha, mcpb_name, mcpb_sha = sys.argv[4:10]

marketplace = {
    "name": "todd866-plugins",
    "plugins": [
        {
            "name": "mission-control",
            "version": version,
            "description": "Pictorial instrument cockpit, turn-aware AI briefings, adaptive AI Commander, and multi-Mac federation for Antigravity.",
            "source": {
                "source": "url",
                "url": f"{rel_base}/{zip_name}",
                "sha256": zip_sha,
            },
        }
    ],
}
mp_text = json.dumps(marketplace, indent=2) + "\n"
root_mp.write_text(mp_text, encoding="utf-8")
dist_mp.write_text(mp_text, encoding="utf-8")

server_json = {
    "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    "name": "io.github.todd866/antigravity-mission-control",
    "title": "Mission Control for Antigravity",
    "description": "Pictorial instrument cockpit, turn-aware AI briefings, adaptive AI Commander, and multi-Mac federation for Antigravity.",
    "version": version,
    "repository": {
        "url": "https://github.com/todd866/antigravity-mission-control",
        "source": "github",
    },
    "packages": [
        {
            "registryType": "mcpb",
            "identifier": f"{rel_base}/{mcpb_name}",
            "fileSha256": mcpb_sha,
            "transport": {
                "type": "stdio",
            },
        }
    ],
}
srv_path.write_text(json.dumps(server_json, indent=2) + "\n", encoding="utf-8")
PY

echo "Packaged plugin zip: $ZIP_PATH (sha256: $ZIP_SHA256)"
echo "Packaged MCP bundle: $MCPB_PATH (sha256: $MCPB_SHA256)"
echo "Updated manifests: $ROOT_MARKETPLACE, $ROOT_SERVER_JSON"

if command -v agy >/dev/null 2>&1; then
  agy plugin validate --strict "$PLUGIN_SRC"
  agy plugin validate --strict "$ZIP_PATH"
  if [[ "${1:-}" == "--validate-remote" ]]; then
    agy plugin validate --strict "$ROOT_MARKETPLACE"
  else
    echo "Next after GitHub release v${VERSION}: ./scripts/package-plugin.sh --validate-remote"
  fi
fi
