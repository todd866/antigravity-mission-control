# Distribution Channels Guide

This document tracks every public distribution channel for **Mission Control for Antigravity**, verified schemas, and release automation.

---

## Channel Status Matrix

| # | Channel | Audience | Mechanism |
| --- | --- | --- | --- |
| 1 | **GitHub Repo + Releases (`.zip` & `.mcpb`)** | All Antigravity & MCP Desktop users | `agy plugin install https://github.com/todd866/antigravity-mission-control/releases/download/v1.2.0/mission-control-plugin-v1.2.0.zip` |
| 2 | **Antigravity `marketplace.json`** | Antigravity IDE / CLI catalog | Root [`marketplace.json`](../marketplace.json) + Release asset (`source: "url"` + `sha256`) |
| 3 | **Official Antigravity Marketplace (`antigravity-plugins-official`)** | Built-in Antigravity Marketplace UI | Passes `agy plugin validate --strict`; awaits Google partner curation |
| 4 | **Official MCP Registry (`registry.modelcontextprotocol.io`)** | Standardized MCP clients | Root [`server.json`](../server.json) (`mcpb` release asset + `fileSha256`) published automatically via [`.github/workflows/publish-mcp-registry.yml`](../.github/workflows/publish-mcp-registry.yml) using GitHub OIDC |
| 5 | **Homebrew Tap (`todd866/homebrew-tap`)** | macOS CLI & daemon operators | `brew install todd866/tap/antigravity-mission-control` |
| 6 | **MCP Directories (Glama, Smithery, PulseMCP)** | Web discovery & inspectors | Root [`glama.json`](../glama.json) + `server.json` auto-indexing / portal listing |
| 7 | **Community Awesome Lists** | Antigravity & MCP builders | Curated PRs (`awesome-antigravity`, `awesome-mcp-servers`) |
| 8 | **npm (`npx`)** | Node / MCP CLI users | Note: unscoped `antigravity-mission-control` is already taken at `0.9.0` on npm; release `.zip`, `.mcpb`, Official MCP Registry, and Homebrew serve macOS/Node directly without npm name collision (a scoped `@todd866/...` wrapper can be added anytime) |
| 9 | **iOS Companion App** | Mobile operators | Source build via `Local.xcconfig.example` + `bin/agy-control-ios` (optional TestFlight later) |

---

## Release & Packaging Pipeline

Running `./scripts/package-plugin.sh` compiles `plugin/dist/app.html` and `plugin/dist/server.mjs` (esbuild standalone bundles), produces both:

- `dist/mission-control-plugin-v1.2.0.zip` — zero-`npm`-install Antigravity plugin bundle (`bin/launch.sh` + `mcp_config.json` + `plugin.json`)
- `dist/mission-control-v1.2.0.mcpb` — standalone MCP Bundle (`manifest.json` `0.3` + `dist/server.mjs` + `dist/app.html`)

and writes [`marketplace.json`](../marketplace.json) and [`server.json`](../server.json) with matching SHA-256 digests.

```bash
./scripts/package-plugin.sh
gh release create v1.2.0 \
  dist/mission-control-plugin-v1.2.0.zip \
  dist/mission-control-v1.2.0.mcpb \
  marketplace.json \
  --title "v1.2.0 — Pictorial Cockpit & AI Commander"
./scripts/package-plugin.sh --validate-remote
```

Publishing a GitHub Release automatically triggers [`.github/workflows/publish-mcp-registry.yml`](../.github/workflows/publish-mcp-registry.yml), which validates `server.json`, authenticates via GitHub OIDC (`mcp-publisher login github-oidc`), and publishes `io.github.todd866/antigravity-mission-control` to `registry.modelcontextprotocol.io`.
