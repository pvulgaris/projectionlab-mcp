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

const cmd = process.argv[2] ?? "serve";

async function main() {
  switch (cmd) {
    case "serve":
      await serve();
      break;
    case "login":
      await loginInteractive();
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
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep process alive until stdio closes; the SDK handles cleanup.
  // Best-effort cleanup on signals.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await shutdown().catch(() => {});
      process.exit(0);
    });
  }
}

function printHelp() {
  process.stdout.write(
    [
      "pl-mcp — ProjectionLab MCP server",
      "",
      "Usage: pl-mcp [serve|login|logout|status]",
      "",
      "Commands:",
      "  serve     Run the MCP server over stdio (default).",
      "  login     Open a headed browser for one-time Firebase sign-in.",
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
