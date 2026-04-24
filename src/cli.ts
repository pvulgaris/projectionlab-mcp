#!/usr/bin/env node

/**
 * pl-mcp — CLI entry point.
 *
 * Subcommands:
 *   serve   (default) Run the MCP server over stdio.
 *   login           Open a headed browser for one-time Firebase sign-in.
 *   logout          Remove the persisted browser profile.
 *   status          Print session diagnostics.
 */

import fs from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { loginInteractive, statusReport, shutdown } from "./browser.js";
import { config } from "./config.js";
import { tryAcquireLock, releaseLock, readLockOwner } from "./lock.js";
import { runDaemon } from "./daemon.js";

const cmd = process.argv[2] ?? "serve";

async function main() {
  switch (cmd) {
    case "daemon":
      await daemon();
      break;
    case "serve":
      await serve();
      break;
    case "login":
      await login();
      break;
    case "logout":
      await shutdown();
      await fs.rm(config.profileDir, { recursive: true, force: true });
      process.stderr.write(`Removed profile at ${config.profileDir}\n`);
      break;
    case "status": {
      const r = await statusReport();
      await shutdown();
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      break;
    }
    case "-h":
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }
}

async function serve() {
  acquireLockOrExit();
  installShutdownHandlers();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function daemon() {
  // Optional --port arg
  let port: number | undefined;
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === "--port" && process.argv[i + 1]) {
      port = parseInt(process.argv[i + 1], 10);
      i++;
    }
  }
  acquireLockOrExit();
  installShutdownHandlers();
  runDaemon(port);
  // runDaemon binds the listener; process stays alive until SIGINT/SIGTERM.
}

function acquireLockOrExit() {
  const conflict = tryAcquireLock();
  if (conflict) {
    process.stderr.write(`pl-mcp: ${conflict.message}\n`);
    process.exit(2);
  }
}

function installShutdownHandlers() {
  process.on("exit", () => releaseLock());
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await shutdown().catch(() => {});
      releaseLock();
      process.exit(0);
    });
  }
}

async function login() {
  // Login launches its own Chromium against the profile, so it has the same
  // contention problem as serve. Surface the conflict before touching the
  // profile so the user knows exactly what to kill.
  const owner = readLockOwner();
  if (owner?.alive) {
    process.stderr.write(
      `pl-mcp: a server (PID ${owner.pid}) is currently using the profile.\n` +
        `Logging in while another process holds the profile produces inconsistent auth state.\n` +
        `Stop it first:\n` +
        `  kill ${owner.pid}\n` +
        `or kill all pl-mcp processes:\n` +
        `  pkill -f projectionlab-mcp\n` +
        `Then re-run pl-mcp login.\n`,
    );
    process.exit(2);
  }
  await loginInteractive();
}

function printHelp() {
  process.stdout.write(
    [
      "pl-mcp — ProjectionLab MCP server",
      "",
      "Usage: pl-mcp [daemon|serve|login|logout|status] [options]",
      "",
      "Commands:",
      "  daemon    Run the long-lived HTTP daemon (recommended). All MCP clients",
      "            connect to one shared instance. Use --port to override (default 7301).",
      "  serve     Run the MCP server over stdio (one-process-per-host; legacy).",
      "  login     Open a headed browser for one-time Firebase sign-in (CLI fallback;",
      "            prefer the pl_login_interactive MCP tool when daemon is running).",
      "  logout    Remove the persisted browser profile.",
      "  status    Print session diagnostics as JSON.",
      "",
      "Environment variables:",
      "  PROJECTIONLAB_KEY_PATH       Plugin API key file (default: ~/.config/projectionlab/key)",
      "  PROJECTIONLAB_PROFILE_DIR    Persistent browser profile (default: ~/.config/projectionlab/profile)",
      "  PROJECTIONLAB_BACKUPS_DIR    Snapshot output dir (default: ~/.config/projectionlab/backups)",
      "  PROJECTIONLAB_HEADLESS       Set to 'false' to run the server with a visible browser (default: true)",
      "  PROJECTIONLAB_BASE_URL       App URL (default: https://app.projectionlab.com/)",
      "",
    ].join("\n"),
  );
}

main().catch(async (err) => {
  process.stderr.write(`pl-mcp: ${String(err?.message ?? err)}\n`);
  await shutdown().catch(() => {});
  process.exit(1);
});
