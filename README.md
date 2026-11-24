# Mission Control for Antigravity

Fixed-order status cockpit, AI project briefings, multi-Mac federation, fast idle-tab controls with **"What's next"** prompt suggestions, CLI instrument view, and native SwiftUI iOS companion for managing [Antigravity](https://antigravity.google.com) sessions from any Mac or iPhone.

## Components

- **Desktop MCP App (`plugin/`)** — Fixed-slot cockpit (`Waiting`, `Working`, `Background`, `Unread`, `Idle`) across connected Macs, one-click **Send to bottom** (`⤓` or `b`) / **Pin** (`p`), inline **`What's next`** pills and action cards (`Send` / `Edit`), inline prompt composer, `+ New` multi-Mac thread launcher, clean Markdown transcript viewer, and fleet CLI agent view.
- **Turn-Aware Briefings (`plugin/src/state.mjs`, `plugin/src/briefing.mjs`)** — Separates current-turn focus/checklists from prior-turn state and caches plain-English briefings plus 1–3 contextual `nextActions` via `agy -p --model gemini-3.8-flash-low`.
- **Multi-Mac Peer Federation (`plugin/src/federation.mjs`)** — Aggregates Antigravity boards, projects, and CLI fleet agents across Macs over Tailscale HTTPS while keeping unified fixed slot order and routing `Focus`, `Stop`, `Send`, `Brief`, and `New Conversation` to the owning Mac.
- **CLI Status Table (`bin/agy-status`)** — Aligned federated terminal readout (`agy-status`, `--local`, `--json`, `--all`).
- **Mac Companion Daemon (`server/agy-control-api.mjs`)** — Loopback HTTP API (`127.0.0.1:8696` by default, configurable via `AGY_CONTROL_PORT`) protected by Bearer token (`timingSafeEqual`) for tailnet exposure via `tailscale serve`.
- **Native iOS App (`ios/`)** — SwiftUI companion (`Mission Control`, iOS 18+) with Keychain-backed primary + fallback server failover (`agycontrol://pair?url=...&fallback=...&token=...`), Mac filter chips, trailing **Bottom** swipe action, leading **Next** swipe action, AI briefings, `"What's next"` quick-send/edit cards, and fleet monitor.

## Quick Start

### 1. Install the Antigravity Desktop Plugin

Requires Node.js 22+ (for `node:sqlite`).

```bash
./scripts/install-plugin.sh
```

Reload MCP servers in Antigravity (or restart Antigravity) and open **Mission Control** from the global toolbar or auxiliary pane.

Optionally symlink the CLI status table onto your `PATH`:

```bash
ln -sf "$(pwd)/bin/agy-status" ~/.local/bin/agy-status
```

### 2. Run the Mac Companion API (Tailnet-Only)

Install the LaunchAgent and generate a 64-hex bearer token at `~/.local/state/agy-control/token`:

```bash
./scripts/install-daemon.sh
# If port 8696 is in use on a secondary Mac, pick another loopback port:
# AGY_CONTROL_PORT=8698 ./scripts/install-daemon.sh
```

Expose the loopback service exclusively inside your Tailscale tailnet:

```bash
tailscale serve --bg --https=8446 http://127.0.0.1:8696
```

To allow remote `Focus`, `Stop`, `Send`, and `New Conversation` actions from iPhone or peer Macs, grant **Accessibility** permission to the `node` binary used by the daemon in **System Settings > Privacy & Security > Accessibility**.

### 3. Connect Multiple Macs (Optional)

Copy [`config/peers.json.example`](config/peers.json.example) to `~/.config/agy-control/peers.json` (`0600`) on each Mac, copy the shared `~/.local/state/agy-control/token` (`0600`) between them, and list each peer's Tailscale Serve URL:

```json
{
  "selfName": "mac-primary",
  "peers": [
    {
      "name": "mac-secondary",
      "url": "https://mac-secondary.your-tailnet.ts.net:8446",
      "tokenFile": "~/.local/state/agy-control/token"
    }
  ]
}
```

### 4. Build, Test, and Pair the iOS App

Requires Xcode 16+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

1. Copy [`ios/Config/Local.xcconfig.example`](ios/Config/Local.xcconfig.example) to `ios/Config/Local.xcconfig` (gitignored) and fill in your Apple Team ID, bundle identifier, primary Tailscale URL, optional fallback Tailscale URL, and iPhone UDID:

   ```bash
   cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig
   ```

2. Run Simulator tests:

   ```bash
   ./bin/agy-control-ios test --destination "platform=iOS Simulator,name=iPhone 16"
   ```

3. Build, install, and pair onto your iPhone (encodes both `url` and `fallback` when `AGY_FALLBACK_SERVER` is configured):

   ```bash
   ./bin/agy-control-ios install-device
   ./bin/agy-control-ios pair-device
   ```

## Security Model

- `agy-control-api.mjs` binds only to `127.0.0.1` and relies on `tailscale serve` (never public `funnel`) for remote HTTPS inside your tailnet.
- Every `/v1/*` request requires an `Authorization: Bearer <token>` header validated in constant time (`timingSafeEqual`), and peer forwarding sets `?localOnly=1` to prevent proxy loops.
- Tokens and peer configs live outside the repository (`~/.local/state/agy-control/token`, `~/.config/agy-control/peers.json`, `0600`), and iOS credentials are stored in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
- Before sending a remote prompt or starting a thread, the Mac controller checks whether Antigravity's composer already holds an unsent draft and aborts with HTTP `409` instead of overwriting it.

## License

[MIT](LICENSE)
