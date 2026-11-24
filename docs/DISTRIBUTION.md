# Distribution Channels Guide

This document maps every public distribution channel for **Mission Control for Antigravity**, including exact prerequisites, verified schemas, and publish commands.

---

## Channel Readiness Matrix

| # | Channel | Audience | Status | Install Mechanism |
| --- | --- | --- | --- | --- |
| 1 | **GitHub Repo + Releases (`.zip`)** | All Antigravity users | Ready locally (awaiting tag push) | `agy plugin install <release-zip-url>` |
| 2 | **Self-Hosted Antigravity `marketplace.json`** | Antigravity IDE / CLI catalog | Schema ready (`dist/marketplace.json`) | `agy plugin install mission-control@<marketplace>` |
| 3 | **Official Antigravity Marketplace (`antigravity-plugins-official`)** | Built-in Antigravity Marketplace UI | Strict validation passes (`agy plugin validate --strict`) | Google / partner submission & review |
| 4 | **npm (`npx antigravity-mission-control`)** | Node / MCP CLI users | Manifest + bundled `dist/server.mjs` ready | `npm publish` (`package.json` setup) |
| 5 | **Official MCP Registry (`registry.modelcontextprotocol.io`)** | Standardized MCP clients | `server.json` authored at repo root | `mcp-publisher login github && mcp-publisher publish` |
| 6 | **MCP Directories (Glama, Smithery, PulseMCP, MCP.so)** | Web discovery & inspectors | Repo + `README` + `server.json` ready | Submit public GitHub URL (auto-indexes MCP Registry) |
| 7 | **Homebrew Tap (`brew tap todd866/tap`)** | macOS power users (`agy-status`, daemon) | Scripts ready (`install-plugin.sh`, `install-daemon.sh`) | Create `Formula/mission-control.rb` in tap repo |
| 8 | **Community Awesome Lists** | Antigravity & MCP builders | Ready after `v1.2.0` release | PRs to `awesome-antigravity`, `Google_Antigravity_Plugins`, `awesome-mcp-servers` |
| 9 | **iOS Companion App** | Mobile operators | Builds via `XcodeGen` + `Local.xcconfig` | Source build, Tailnet OTA, or public TestFlight link |

---

## 1. GitHub Public Release + Standalone Plugin Archive

Running `./scripts/package-plugin.sh` compiles the bundled frontend (`dist/app.html`) and bundled MCP server (`dist/server.mjs`), writes a portable Node 22+ launcher (`bin/launch.sh`), and generates two release artifacts in `dist/`:

- `dist/mission-control-plugin-v1.2.0.zip` — zero-`npm`-install Antigravity plugin bundle
- `dist/marketplace.json` — cryptographic URL+SHA256 marketplace catalog entry

Both `plugin/` and the generated `.zip` pass `agy plugin validate --strict` with zero errors and zero warnings.

### Release Checklist

1. Ensure GitHub repository topics include: `antigravity`, `antigravity-plugins`, `mcp`, `mcp-app`, `mcp-server`, `ai-agents`, `swiftui`, `macos`.
2. Push commits on `main`, build the release bundle (`./scripts/package-plugin.sh`), create tag `v1.2.0`, and attach `dist/mission-control-plugin-v1.2.0.zip` + `dist/marketplace.json` to the GitHub Release:

   ```bash
   gh release create v1.2.0 \
     dist/mission-control-plugin-v1.2.0.zip \
     dist/marketplace.json \
     --title "v1.2.0 — Pictorial Cockpit & AI Commander" \
     --notes "Adds adaptive AI Commander, pictorial step/phase UI, keyboard palette, zero-ellipsis layout, and standalone bundled plugin zip."
   ```

3. Verify the published remote marketplace catalog cleanly:

   ```bash
   ./scripts/package-plugin.sh --validate-remote
   ```

---

## 2. Antigravity `marketplace.json` Catalog Format

Empirically verified against `agy plugin validate --strict`:

- `plugins[].version` is required for Antigravity Marketplace inclusion.
- Remote archive sources require `"source": "url"`, `"url": "https://..."`, and a matching 64-hex `"sha256"`.

Generated schema in `dist/marketplace.json`:

```json
{
  "name": "todd866-plugins",
  "plugins": [
    {
      "name": "mission-control",
      "version": "1.2.0",
      "description": "Pictorial instrument cockpit, turn-aware AI briefings, adaptive AI Commander, and multi-Mac federation for Antigravity.",
      "source": {
        "source": "url",
        "url": "https://github.com/todd866/antigravity-mission-control/releases/download/v1.2.0/mission-control-plugin-v1.2.0.zip",
        "sha256": "<computed-sha256>"
      }
    }
  ]
}
```

Hosting a repo-level `marketplace.json` (or attaching it to releases) lets users register the catalog directly and keeps SHA256 verification intact.

---

## 3. Official Antigravity Plugin Marketplace (`antigravity-plugins-official`)

First-party and vetted partner plugins appear inside Antigravity under **Customizations → Marketplace**. Inclusion is curated by Google rather than self-uploaded.

Prerequisites already satisfied in this repo:

- `plugin/plugin.json` includes `name`, `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `logo` (`assets/logo.svg`), and 3 `suggestedPrompts`.
- `plugin/dist/app.html` bundles all CSS/JS into one CSP-clean MCP App resource (`ui://mission-control/app.html`).
- App-only state/mutation tools set `_meta: { ui: { visibility: ['app'] } }`.
- Zero errors/warnings under `agy plugin validate --strict`.

---

## 4. npm Package Distribution (`npx`)

Because `plugin/dist/server.mjs` and `plugin/dist/app.html` bundle into standalone JS + single-file HTML:

- Publishing a thin wrapper npm package (`antigravity-mission-control`) with `"bin": { "antigravity-mission-control": "./dist/server.mjs", "agy-control-install": "./bin/install.mjs" }` lets MCP clients run it directly via `npx -y antigravity-mission-control` or install the Antigravity plugin cleanly in one command.
- Keep `"engines": { "node": ">=22.0.0" }` so npm warns users below Node 22 (`node:sqlite`).

---

## 5. Official MCP Registry (`registry.modelcontextprotocol.io`)

Root [`server.json`](../server.json) conforms to the canonical MCP Registry schema (`https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json`) under namespace `io.github.todd866/antigravity-mission-control`.

Publish flow once npm package or release tarball is live:

```bash
# Install mcp-publisher from github.com/modelcontextprotocol/registry/releases
mcp-publisher login github
mcp-publisher publish
```

For automated releases on `v*` tags, add a GitHub Actions workflow using `id-token: write` (`mcp-publisher login github-oidc`).

---

## 6. MCP Aggregators & Inspectors

Publishing to the Official MCP Registry automatically propagates into major aggregators; direct submissions accelerate listing and tool verification:

- **Glama** (`glama.ai/mcp/servers`) — Add repository URL for license/quality scan and schema indexing.
- **Smithery** (`smithery.ai`) — Submit GitHub repo + `server.json` for discovery.
- **PulseMCP** (`pulsemcp.com/servers`) — Submit release announcement / repo URL.
- **MCP.so** — Submit community server listing.

---

## 7. Homebrew Tap (`brew tap todd866/tap`)

Great fit for macOS operators who want the CLI cockpit (`agy-status`, `agy-relay`), companion daemon helpers, and plugin installer managed alongside macOS developer tools:

- Archive tag tarball URL (`v1.2.0.tar.gz`) in a Homebrew formula depending on `node@22` (`depends_on "node"`).
- Install `bin/agy-status`, `bin/agy-relay`, `scripts/install-plugin.sh`, and `scripts/install-daemon.sh` with a clear `caveats` block showing `./scripts/install-plugin.sh`.

---

## 8. Community Curated Catalogs & Social Launch

Open PRs once tag `v1.2.0` is live so reviewers immediately see clean screenshots and strict validation:

- Antigravity ecosystem catalogs (`MichaelZelbel/awesome-antigravity`, `smartworldarafath/Google_Antigravity_Plugins`)
- MCP directories (`punkpeye/awesome-mcp-servers`, Model Context Protocol showcase threads)

---

## 9. iOS Companion Distribution

Two public paths for users of the native SwiftUI companion:

1. **Source build (included in `ios/`):** Copy `ios/Config/Local.xcconfig.example`, insert personal Apple Team ID and Tailscale URLs, then build via `./bin/agy-control-ios install-device`.
2. **Public TestFlight (optional future step):** Sign an anonymized build without private host defaults, submit App Store Connect beta review, and link the public TestFlight invite URL in `README.md`.
