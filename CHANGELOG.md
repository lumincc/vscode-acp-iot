# Change Log

All notable changes to the "vscode-acp" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.3.0] - 2026-05-28

### Added
- **EMBEDDER MONITOR sidebar** (`embedderMonitor.serialLog` view): a dark-themed serial console with port / baud / newline pickers, command input, and live log textarea.
- **ACP serial extension protocol** — agents can now drive hardware over the standard ACP socket:
  - Request `acp:serial_connect` ({ port, baud })
  - Request `acp:serial_disconnect`
  - Request `acp:serial_write` ({ data, newline })
  - Notification `acp:serial_data` ({ data }) — streamed live to the agent
- **VirtualSerialSimulator** transparent fallback when the native `serialport` binary fails to load (ABI mismatch / web environment / missing prebuild).
- **Cross-channel diagnostics**: dedicated `Embedder Monitor` output channel + `ACP: Embedder Monitor Diagnostics` command (`acp.serial.diag`).
- **Mode badge in the webview header** (`REAL` / `VIRTUAL`) and `manufacturer / friendlyName` annotations on the port dropdown.
- New configuration:
  - `embedderMonitor.defaultPort` (default empty — auto-pick first port, cross-platform)
  - `embedderMonitor.defaultBaud` (default `115200`)
  - `embedderMonitor.assertControlSignals` (default `true`) — assert DTR/RTS after open so CH340 / CP2102 / ESP32 boards leave reset state
  - `embedderMonitor.fallbackToVirtualOnConnectError` (default `false`) — auto-fallback to virtual simulator on real-port open failure
  - `embedderMonitor.verboseLog` (default `false`) — DEBUG-level event tracing

### Fixed (hotfix round on the v0.3.0 first cut)
- **Packaging dropped `node-gyp-build` / `debug` / `ms`** — the hoisted runtime dependencies of `@serialport/bindings-cpp` were excluded by the `.vscodeignore` allowlist, so installed `.vsix` had only the prebuilt `.node` binary but no loader to bind it. `require('serialport')` then threw `Cannot find module 'node-gyp-build'` and the manager silently fell back to the virtual simulator (Port dropdown showed only `VSIM1/2/3` on real ESP32 setups). `.vscodeignore` now un-ignores these three hoisted modules.
- **"Connected but textarea empty"** — caused by autoOpen / listener race + missing DTR/RTS. Now uses `autoOpen:false` + explicit `open()` after listeners are attached, then `set({dtr:true, rts:true})`.
- **`listPorts` and `connect` racing on `require('serialport')`** — the native module is now loaded once at activation and cached; `currentMode` is single-writer.
- **`close` / `error` events not forwarded to UI** — UI could get stuck in "connected" state. Now `onStatus` broadcasts every transition.
- **Webview ringBuffer / `restoreHistory` race** — incremental `onData` could be clobbered by the bootstrap snapshot. Webview now uses a `bootstrapped` flag.
- **macOS-only default port `/dev/cu.debug-console`** replaced with empty default for cross-platform behavior.

### Changed
- Webpack treats `serialport` as `externals` and `.vscodeignore` ships `node_modules/serialport` and `node_modules/@serialport` so the native binary is loaded from the packaged extension at runtime.
- `SerialManager.disconnect()` is now `async` (awaits the underlying close callback). Callers must `await` it.

## [0.2.0] - 2026-05-16

### Added
- **Session list in the Agents view**: each agent row is now expandable, revealing previous sessions for that agent. Clicking a session restores its history in the chat view.
  - Uses `session/list` when the agent supports it (full source of truth, with cursor pagination).
  - Falls back to a local, per-workspace session cache for agents that support `session/load` / `session/resume` but not `session/list` — captures `sessionId`, title (from `session_info_update`), first prompt, and timestamps.
  - Opening a session uses `session/load` (replays history into the chat) when supported, otherwise `session/resume`.
  - Right-click on a session: **Copy Session ID**. On a locally-cached session: **Forget Session**. On an agent: **Refresh Sessions**.
  - Agents that advertise none of `list` / `load` / `resume` show as a non-expandable leaf, matching prior behavior.
- **Session Config Options** (ACP): generic per-session selector(s) advertised by the agent (e.g. modes, models, thought levels). Pickers are rendered dynamically in the chat composer; the legacy Mode / Model pickers remain as a fallback for agents that haven't migrated yet.
- New command `ACP: Refresh Sessions` (also available via right-click on an agent).

### Changed
- Mode / Model picker dropdowns now show option descriptions in a floating hover tooltip on the side, instead of stacking them inline. Long names display in full, and the dropdown grows responsively with the panel width.
- Bumped `@agentclientprotocol/sdk` from `^0.14.1` to `^0.21.1`. Migrated `unstable_listSessions` / `unstable_resumeSession` to their stable equivalents.

### Fixed
- Agent / model picker labels no longer truncate at 140 px — names display fully and pickers wrap to a second row when the panel is narrow ([#36](https://github.com/formulahendry/vscode-acp/issues/36)).
- Slash-command autocomplete now appears reliably when the agent advertises commands. Notifications like `available_commands_update` that arrive during session creation are persisted on the session even before `activeSessionId` is set.
- Per-session state (config options, available commands, title) carries forward correctly when the active session is set after the notification arrives.

## [0.1.7] - 2026-05-10

### Changed
- **Claude Code**: Updated default package from `@zed-industries/claude-code-acp` to `@agentclientprotocol/claude-agent-acp` (the package was renamed upstream).

## [0.1.6] - 2026-04-20

### Added
- **Kiro CLI**: Added [Kiro CLI](https://kiro.dev/docs/cli/acp/) as a pre-configured agent (`kiro-cli acp`).

## [0.1.5] - 2026-04-19

### Added
- **Hermes Agent**: Added [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp) from Nous Research as a pre-configured agent (`hermes acp`).

## [0.1.4] - 2026-04-18

### Added
- GitHub Actions workflow to publish the extension to both Visual Studio Marketplace and Open VSX Registry

### Fixed
- Pass workspace `cwd` when spawning agent processes, with a fallback to the process working directory

## [0.1.3] - 2026-03-01

### Added
- **OpenClaw**: Added OpenClaw as a pre-configured agent (`npx openclaw acp`)

## [0.1.2] - 2026-02-12

### Added
- **Thinking display**: Show agent thought chunks in a collapsible block with streaming animation and elapsed time
- **Slash commands**: Autocomplete popup for agent-provided commands with keyboard navigation (Arrow/Tab/Enter/Escape)
- Dynamic input placeholder hint when slash commands are available

## [0.1.1] - 2026-02-10

### Added
- Login shell resolution on macOS/Linux to fix `spawn npx ENOENT` errors

### Fixed
- Fixed `autoApprovePermissions` setting: the `allowAll` option was not working due to a value mismatch
- Removed unimplemented `allowRead` option from `autoApprovePermissions` enum

## [0.1.0] - 2026-02-08

### Added
- Initial release of ACP Client for VS Code
- **8 pre-configured agents**: GitHub Copilot, Claude Code, Gemini CLI, Qwen Code, Auggie CLI, Qoder CLI, Codex CLI, OpenCode
- Interactive chat panel with webview UI
- Markdown rendering in assistant messages (via `marked`)
- Inline tool call display with collapsible sections per turn
- Mode and model picker dropdowns in the chat input toolbar
- Single-agent model — one agent active at a time with auto-disconnect
- New conversation confirmation dialog to prevent accidental history loss
- Session management with tree view (connect/disconnect inline icons)
- File system handler for agent file operations
- Terminal handler for agent command execution
- Permission management with configurable auto-approve policies
- ACP protocol traffic logging (enabled by default) with message classification (request/response/notification)
- Client log output channel for debugging
- ACP agent registry browser
- Custom ACP logo for activity bar and extension icon
- Chat state persistence with `retainContextWhenHidden`
- Keyboard shortcuts: `Ctrl+Shift+A` to open chat, `Escape` to cancel turn
