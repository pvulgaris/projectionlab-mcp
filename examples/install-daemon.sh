#!/usr/bin/env bash
#
# Install the pl-mcp daemon as a launchd user agent.
#
# Substitutes path placeholders in the plist template, copies it into
# ~/Library/LaunchAgents/, and bootstraps it. Idempotent: re-running
# replaces an existing install.
#
# Usage:
#   ./examples/install-daemon.sh             # use defaults (port 7301)
#   PROJECTIONLAB_PORT=7333 ./install-daemon.sh

set -euo pipefail

LABEL="com.projectionlab-mcp"
PORT="${PROJECTIONLAB_PORT:-7301}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO/examples/${LABEL}.plist.template"
TARGET="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOGS_DIR="$HOME/Library/Logs"
NODE_BIN="$(command -v node)"

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH. Install Node.js first." >&2
  exit 1
fi

if [ ! -f "$REPO/dist/cli.js" ]; then
  echo "ERROR: $REPO/dist/cli.js missing. Run 'npm install && npm run build' first." >&2
  exit 1
fi

mkdir -p "$LOGS_DIR" "$HOME/Library/LaunchAgents"

# Render template.
sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__REPO__|$REPO|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__PORT__|$PORT|g" \
  "$TEMPLATE" > "$TARGET"

# Unload existing instance if present (idempotent install).
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# Bootstrap the new agent.
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

# Wait briefly for the daemon to start listening.
sleep 1

echo "Installed launchd agent: $TARGET"
echo "Logs:                    $LOGS_DIR/projectionlab-mcp.log"
echo
echo "Daemon URL: http://127.0.0.1:$PORT/mcp"
echo
echo "Next steps:"
echo "  1. Re-register the MCP in Claude Code:"
echo "       claude mcp remove projectionlab -s user 2>/dev/null || true"
echo "       claude mcp add --scope user --transport http projectionlab http://127.0.0.1:$PORT/mcp"
echo
echo "  2. Update Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):"
echo "     replace the projectionlab stdio block with:"
echo '       "projectionlab": { "url": "http://127.0.0.1:'"$PORT"'/mcp" }'
echo
echo "  3. Quit and relaunch Claude Desktop. Restart any open Claude Code sessions."
echo
echo "To uninstall: launchctl bootout gui/\$(id -u)/$LABEL && rm $TARGET"
