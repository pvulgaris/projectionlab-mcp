#!/usr/bin/env node

/**
 * pl-mcp — CLI entry point.
 *
 * Subcommands:
 *   daemon              Run the long-lived HTTP server (recommended).
 *   daemon install      Install + start the launchd user agent (macOS).
 *   daemon uninstall    Stop + remove the launchd user agent (macOS).
 *   bridge              Stdio MCP server that proxies to the running daemon.
 *   serve               Run the MCP server over stdio (single-host fallback).
 *   login               Open a headed browser for one-time Firebase sign-in.
 *   logout              Remove the persisted browser profile.
 *   status              Print session diagnostics.
 */

import fs from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { loginInteractive, statusReport, shutdown } from "./browser.js";
import { config } from "./config.js";
import { tryAcquireLock, releaseLock, readLockOwner } from "./lock.js";
import { runDaemon } from "./daemon.js";
import { runBridge } from "./bridge.js";
import { installDaemon, uninstallDaemon } from "./install.js";

const cmd = process.argv[2] ?? "serve";

async function main() {
  switch (cmd) {
    case "daemon":
      await daemon();
      break;
    case "bridge":
      await runBridge();
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
  const sub = process.argv[3];
  if (sub === "install") {
    await installDaemon(parsePortArg(4));
    return;
  }
  if (sub === "uninstall") {
    await uninstallDaemon();
    return;
  }

  // No subcommand → run the daemon in-process.
  acquireLockOrExit();
  installShutdownHandlers();
  runDaemon(parsePortArg(3));
}

function parsePortArg(startIndex: number): number | undefined {
  for (let i = startIndex; i < process.argv.length; i++) {
    if (process.argv[i] === "--port" && process.argv[i + 1]) {
      const n = parseInt(process.argv[i + 1], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
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
      "Usage: pl-mcp <command> [options]",
      "",
      "Commands:",
      "  daemon                Run the HTTP daemon in this process (--port N to override).",
      "  daemon install        Install + start the launchd user agent (macOS).",
      "  daemon uninstall      Stop + remove the launchd user agent (macOS).",
      "  bridge                Stdio→HTTP proxy. Use this in Claude Desktop's config:",
      "                          {\"command\": \"pl-mcp\", \"args\": [\"bridge\"]}",
      "  serve                 Run the MCP server over stdio (single-host fallback).",
      "  login                 Open a headed browser for one-time Firebase sign-in.",
      "                          (Prefer the pl_login_interactive MCP tool when daemon is up.)",
      "  logout                Remove the persisted browser profile.",
      "  status                Print session diagnostics as JSON.",
      "",
      "Environment variables:",
      "  PROJECTIONLAB_KEY_PATH       Plugin API key file (default: ~/.config/projectionlab/key)",
      "  PROJECTIONLAB_PROFILE_DIR    Persistent browser profile (default: ~/.config/projectionlab/profile)",
      "  PROJECTIONLAB_BACKUPS_DIR    Snapshot output dir (default: ~/.config/projectionlab/backups)",
      "  PROJECTIONLAB_HEADLESS       Set to 'false' to run with a visible browser (default: true)",
      "  PROJECTIONLAB_BASE_URL       App URL (default: https://app.projectionlab.com/)",
      "  PROJECTIONLAB_PORT           Daemon/bridge port (default: 7301)",
      "",
    ].join("\n"),
  );
}

main().catch(async (err) => {
  process.stderr.write(`pl-mcp: ${String(err?.message ?? err)}\n`);
  await shutdown().catch(() => {});
  process.exit(1);
});
