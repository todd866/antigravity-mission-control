#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/MissionControlHelper.swift"
DST="${AGY_HELPER_DST:-/Applications/Mission Control Helper.app}"
BUNDLE_ID="${AGY_HELPER_BUNDLE_ID:-org.example.agy-control-helper}"

pick_identity() {
  if [[ -n "${AGY_SIGN_IDENTITY:-}" ]]; then
    printf '%s\n' "$AGY_SIGN_IDENTITY"
    return 0
  fi
  local found
  found="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1 || true)"
  if [[ -n "$found" ]]; then
    printf '%s\n' "$found"
    return 0
  fi
  found="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1 || true)"
  if [[ -n "$found" ]]; then
    printf '%s\n' "$found"
    return 0
  fi
  printf '%s\n' "-"
}

SIGN_ID="$(pick_identity)"
CONTENTS="$DST/Contents"
MACOS_DIR="$CONTENTS/MacOS"
BIN_PATH="$MACOS_DIR/MissionControlHelper"

mkdir -p "$MACOS_DIR"
swiftc -O -o "$BIN_PATH" "$SRC"

cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Mission Control Helper</string>
  <key>CFBundleExecutable</key>
  <string>MissionControlHelper</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Mission Control Helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF

codesign --force --sign "$SIGN_ID" --identifier "$BUNDLE_ID" "$DST"
codesign --verify --deep --strict "$DST"
echo "Built and signed $DST ($BUNDLE_ID) with identity: $SIGN_ID"
