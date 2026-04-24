# projectionlab-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [ProjectionLab](https://projectionlab.com). Exposes plan reads, account updates, snapshots, and rollback as MCP tools — so you can ask Claude (or any MCP-aware host) things like:

- *What's in my ProjectionLab plan?*
- *Show me my account balances.*
- *Back up my ProjectionLab plan.*
- *Update my Fidelity 401k balance to 125000.*
- *Undo my last change.*

It works by driving a persistent headless Playwright browser against an authenticated ProjectionLab tab and calling `window.projectionlabPluginAPI`. In daemon mode, all your MCP hosts (Claude Code, Claude Desktop, etc.) share one browser instance and one auth state.

A thin skill at [`skills/projectionlab/SKILL.md`](skills/projectionlab/SKILL.md) covers workflow conventions (confirm-before-write, batch update patterns).

## Status

- **Read** — full export summary plus six scoped tools (accounts, milestones, income/expenses, Monte Carlo, withdrawal strategy, tax variables).
- **Write** — single-account atomic `pl_update_account` (balance, cost basis), with verify. Auto-snapshots before every mutation.
- **Snapshot** — full `exportData` to a timestamped JSON file under `~/.config/projectionlab/backups/`.
- **Rollback** — `pl_restore_preview` / `pl_restore_apply` re-apply balances + cost basis from any snapshot. Reference snapshots by index (`n_back`), absolute time (`before_time`), or path. Limited to balance/costBasis (same surface as `pl_update_account`).

## Install

### Prerequisites

- **Node.js 20+** — install via `brew install node` or from [nodejs.org](https://nodejs.org).
- **git** — included with the macOS Xcode Command Line Tools (`xcode-select --install` triggers the install if you don't have them yet).
- **ProjectionLab account with Plugins enabled** — the Plugin API is a Pro-tier feature. If you don't see the **Plugins** menu under ProjectionLab Settings, you'll need to upgrade.
- **An MCP host** — at least one of [Claude Code](https://claude.com/claude-code) (CLI) or [Claude Desktop](https://claude.ai/download) (Mac app).
- **macOS** — the daemon flow uses `launchd`. The stdio fallback works on Linux too.

The server downloads its own Chromium via Playwright on first install.

### Clone and build

Clone wherever you keep your code; the rest of these instructions assume you're in the repo root.

```sh
git clone https://github.com/pvulgaris/projectionlab-mcp.git
cd projectionlab-mcp
npm install
npx playwright install chromium
npm run build
```

### 1. Generate and save your Plugin API key

In ProjectionLab: **Settings > Plugins**, enable Plugins, generate a key. Save it locally:

```sh
mkdir -p ~/.config/projectionlab
printf '%s' 'YOUR_PLUGIN_API_KEY' > ~/.config/projectionlab/key
chmod 600 ~/.config/projectionlab/key
```

### 2. Install the daemon (recommended)

The daemon runs as a launchd user agent. All MCP clients (Claude Code, Claude Desktop, etc.) connect to one shared instance over HTTP — same Chromium, same auth, no per-host process management.

```sh
./examples/install-daemon.sh
```

The script renders the launchd plist, bootstraps the agent, and prints the next steps.

### 3. Register the MCP server in your hosts

**Claude Code:**

```sh
claude mcp remove projectionlab -s user 2>/dev/null || true
claude mcp add --scope user --transport http projectionlab http://127.0.0.1:7301/mcp
```

**Claude Desktop:** the desktop app's `claude_desktop_config.json` accepts only stdio MCP entries (HTTP/SSE servers are managed via the in-app Connectors UI for Anthropic-hosted ones). Use `mcp-remote` as a stdio→HTTP bridge:

```json
"projectionlab": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://127.0.0.1:7301/mcp", "--allow-http"]
}
```

`--allow-http` is required because mcp-remote defaults to HTTPS-only; localhost is the exception. The first launch downloads `mcp-remote` from npm and is slow; subsequent launches use the npx cache.

Quit and relaunch Claude Desktop. Restart any open Claude Code sessions.

### 4. Sign in (first time)

In any host, ask Claude:

> sign me into ProjectionLab

The agent will call `pl_login_interactive`, a headed browser opens, you sign in, and you're done. No CLI command needed; the daemon handles everything.

### 5. Link the skill (optional)

From the repo root:

```sh
ln -sfn "$(pwd)/skills/projectionlab" ~/.claude/skills/projectionlab
```

### Stdio fallback (development / non-daemon use)

If you'd rather not run the daemon (e.g., for development), you can still register the stdio server per-host:

```sh
claude mcp add projectionlab -- node /path/to/projectionlab-mcp/dist/cli.js serve
```

The singleton lock prevents accidental multi-process corruption, but you can only have one host using PL at a time.

## Verify

The natural way: in any MCP host, ask Claude:

> check ProjectionLab session status

That calls `pl_session_status`, which returns JSON like:

```json
{
  "apiKeyPresent": true,
  "browserAlive": true,
  "signedIn": true,
  "pluginApiReady": true,
  ...
}
```

Or test the daemon directly with `curl` (works regardless of MCP host):

```sh
curl -s -X POST http://127.0.0.1:7301/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}'
```

A 200 with an `initialize` result means the daemon is live. (Note: `node dist/cli.js status` works only when the daemon is **not** running — the singleton lock prevents two pl-mcp processes from sharing a profile.)

In a fresh MCP-host session, smoke-test the tool surface:

- *"What's in my ProjectionLab plan?"* → calls `pl_export`, returns counts/structure.
- *"Back up my plan."* → calls `pl_snapshot`, file appears in `~/.config/projectionlab/backups/`.
- *"Update my Brokerage balance to 100000."* → confirms with you, calls `pl_update_account`, verifies.

## Tools

| Tool | Purpose |
|---|---|
| `pl_session_status` | Diagnostics. Never throws. |
| `pl_validate_key` | Cheap auth probe. |
| `pl_export` | High-level plan summary (counts, structure). |
| `pl_get_accounts` | Today-account roster (savings + investment + assets). |
| `pl_get_account` | One account by id or name; multi-match returns candidates. |
| `pl_get_milestones` | Plan milestones. |
| `pl_get_income_expenses` | Plan income and expense events. |
| `pl_get_monte_carlo` | Monte Carlo settings. |
| `pl_get_withdrawal_strategy` | Active withdrawal strategy + nested config. |
| `pl_get_tax_variables` | Tax variables. |
| `pl_update_account` | Atomic single-account write (balance, costBasis). Auto-snapshots first. |
| `pl_snapshot` | Full export to a timestamped JSON file. |
| `pl_list_snapshots` | List recent snapshots (index 0 = most recent). |
| `pl_snapshot_stats` | Aggregate count + total bytes; oldest/newest. |
| `pl_restore_preview` | Read-only diff: what `pl_restore_apply` would change. |
| `pl_restore_apply` | Re-apply balances + costBasis from a snapshot (preview first; confirm). |
| `pl_reload_session` | Close + re-launch the browser context (post-login recovery; legacy stdio mode). |
| `pl_login_interactive` | Open a headed browser for the user to sign into ProjectionLab. Daemon-mode preferred. |

## Configuration

All paths are env-overridable so the repo stays generic:

| Variable | Default |
|---|---|
| `PROJECTIONLAB_KEY_PATH` | `~/.config/projectionlab/key` |
| `PROJECTIONLAB_PROFILE_DIR` | `~/.config/projectionlab/profile` |
| `PROJECTIONLAB_BACKUPS_DIR` | `~/.config/projectionlab/backups` |
| `PROJECTIONLAB_HEADLESS` | `true` (set `false` to see the browser) |
| `PROJECTIONLAB_BASE_URL` | `https://app.projectionlab.com/` |

Pass via `claude mcp add ... -e VAR=value` if you need non-default paths.

## Architecture

The Plugin API is a browser-only object — there is no server-side REST. This MCP solves that by holding a persistent Playwright Chromium with a user-data-dir for the Firebase session.

```
Claude Code
  │
  ▼
mcp__projectionlab__<tool>  ──►  pl-mcp serve (this repo)
                                       │
                                       ▼
                                  Playwright (headless Chromium)
                                       │
                                       ▼
                              window.projectionlabPluginAPI
                                  on app.projectionlab.com
```

The browser launches lazily on the first tool call and is held for the lifetime of the server process.

## Operations

### Rotate the Plugin API key

```sh
printf '%s' 'NEW_KEY' > ~/.config/projectionlab/key
chmod 600 ~/.config/projectionlab/key
```

The server reads the key file on every call; no restart needed.

### One-server-per-profile rule

Two pl-mcp processes using the same `PROJECTIONLAB_PROFILE_DIR` corrupt Chromium's LevelDB cookie/IndexedDB stores. The CLI enforces this with a PID lock file at `<profile>/.pl-mcp-server.pid`:

- `pl-mcp daemon` and `pl-mcp serve` refuse to start if another live server holds the lock.
- `pl-mcp login` refuses to start if a server is currently active (use `pl_login_interactive` MCP tool instead).

The recommended daemon mode + launchd makes this a non-issue: launchd ensures exactly one daemon is running, and all MCP clients share it.

### Re-login when the Firebase session expires

In any host, ask Claude:

> sign me into ProjectionLab

That triggers the `pl_login_interactive` tool. The daemon temporarily shuts down its headless Chromium, opens a headed window, waits for sign-in, then re-launches headless against the freshly-signed-in profile. Other tool calls during login return `login_in_progress`.

CLI fallback (only when the daemon isn't running): `node dist/cli.js login` — same headed-browser flow, but you'll need to start the daemon back up afterwards.

### Wipe the persistent profile

```sh
node dist/cli.js logout
```

### Run with a visible browser (debugging)

```sh
PROJECTIONLAB_HEADLESS=false node dist/cli.js serve
```

### Snapshots

Snapshots live at `~/.config/projectionlab/backups/projectionlab-<iso>.json`, mode 0600. The Plugin API key is redacted before write.

**Two ways snapshots get created:**
- Explicit: a `pl_snapshot` call.
- Implicit: every `pl_update_account` auto-snapshots first, so every mutation is reversible via `pl_restore_apply`.

**Retention policy: none in v1.** Prune manually:

```sh
ls -lh ~/.config/projectionlab/backups/         # browse
node dist/cli.js status                          # current paths/config
# Inside Claude: ask "what's the snapshot stats?" — calls pl_snapshot_stats.
```

Per-snapshot size is ~50–60KB. Even 10 mutations a day is ~18MB/year. **Revisit retention if `pl_snapshot_stats` shows the directory growing past a few hundred MB.** Likely future policy: keep all from the last 7 days, then daily checkpoints.

### Rolling back a mutation

```
You: undo my last change
Claude: [calls pl_restore_preview({n_back: 1})]
Claude: Restore proposed (from snapshot taken 2026-04-24T15:42:01Z):
          Brokerage (taxable): balance 125000 → 100000
        Confirm? (yes/no)
You: yes
Claude: [calls pl_restore_apply({n_back: 1})]
        ✓ Brokerage reverted; verified.
```

Time-based: *"undo back to before noon today"* → `pl_restore_preview({ before_time: "2026-04-24T12:00:00Z" })`.

## Security

- The Plugin API key file is mode 0600. Never commit it. Never echo it in prose.
- The persistent profile contains your Firebase session cookies — treat the directory as sensitive.
- Writes require explicit user confirmation per call (enforced by the skill, not the server). The server itself does not gate writes.
- Restore-style methods (whole-section replace) are intentionally not exposed.

## Non-goals

- Executing trades or moving money.
- Replacing ProjectionLab's projection engine.
- Productizing or maintaining for others. Shared as-is under MIT.

---

*ProjectionLab is a trademark of its owner. This project is an independent integration and is not affiliated with or endorsed by ProjectionLab.*
