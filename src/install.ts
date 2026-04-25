/**
 * pl-mcp daemon install / uninstall — manage the launchd user agent.
 *
 * Bundles what was previously a separate examples/install-daemon.sh: render
 * the plist from an in-code template, drop it in ~/Library/LaunchAgents/, and
 * bootstrap it. After kickstart we poll the daemon's /mcp endpoint to confirm
 * it's actually answering before declaring success.
 *
 * macOS only — refuses to run on other platforms (the stdio fallback works
 * everywhere).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LABEL = "com.projectionlab-mcp";
const DEFAULT_PORT = 7301;

function plistTemplate(opts: {
  node: string;
  cli: string;
  workingDir: string;
  home: string;
  port: number;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${opts.node}</string>
        <string>${opts.cli}</string>
        <string>daemon</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>PROJECTIONLAB_PORT</key>
        <string>${opts.port}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>${opts.home}/Library/Logs/projectionlab-mcp.log</string>

    <key>StandardErrorPath</key>
    <string>${opts.home}/Library/Logs/projectionlab-mcp.log</string>

    <key>WorkingDirectory</key>
    <string>${opts.workingDir}</string>
</dict>
</plist>
`;
}

function plistPath(home: string): string {
  return path.join(home, "Library/LaunchAgents", `${LABEL}.plist`);
}

function launchctl(args: string[], opts: { ignoreFailure?: boolean } = {}): number {
  const r = spawnSync("launchctl", args, { stdio: "inherit" });
  const code = r.status ?? -1;
  if (code !== 0 && !opts.ignoreFailure) {
    throw new Error(`launchctl ${args.join(" ")} failed (exit ${code})`);
  }
  return code;
}

async function bootstrapWithRetry(guiTarget: string, plistFile: string): Promise<void> {
  // The previous instance's process may take a moment to release its port even
  // after bootout returns. If bootstrap races against that, launchd reports
  // "Input/output error" (exit 5). Retry a few times with backoff.
  const attempts = 4;
  for (let i = 0; i < attempts; i++) {
    const code = launchctl(["bootstrap", guiTarget, plistFile], { ignoreFailure: i < attempts - 1 });
    if (code === 0) return;
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
}

function refuseOnNonDarwin(): void {
  if (process.platform !== "darwin") {
    process.stderr.write(
      `pl-mcp daemon install: launchd is macOS-only. ` +
        `On Linux, register the stdio server with your MCP host instead (see README "Stdio fallback").\n`,
    );
    process.exit(2);
  }
}

function resolvePort(arg: number | undefined): number {
  if (arg && Number.isFinite(arg)) return arg;
  if (process.env.PROJECTIONLAB_PORT) {
    const n = parseInt(process.env.PROJECTIONLAB_PORT, 10);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_PORT;
}

async function pollDaemon(port: number, timeoutMs: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/mcp`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // GET returns 405 from our stateless transport — any HTTP response means alive.
      await fetch(url, { method: "GET" });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

export async function installDaemon(portArg?: number): Promise<void> {
  refuseOnNonDarwin();
  const port = resolvePort(portArg);
  const home = os.homedir();
  const node = process.execPath;
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  // dist/cli.js → repo root is two levels up.
  const workingDir = path.resolve(path.dirname(cli), "..");
  const target = plistPath(home);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.join(home, "Library/Logs"), { recursive: true });
  fs.writeFileSync(target, plistTemplate({ node, cli, workingDir, home, port }));

  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}/${LABEL}`;
  const guiTarget = `gui/${uid}`;

  // Idempotent: bootout an existing instance first, ignoring the "not loaded" failure.
  launchctl(["bootout", domain], { ignoreFailure: true });
  await bootstrapWithRetry(guiTarget, target);
  launchctl(["enable", domain]);
  launchctl(["kickstart", "-k", domain]);

  process.stderr.write(`Wrote ${target}\nWaiting for daemon to come up…\n`);
  const alive = await pollDaemon(port, 5000);
  if (!alive) {
    process.stderr.write(
      `pl-mcp daemon install: daemon did not respond within 5s. ` +
        `Check ${home}/Library/Logs/projectionlab-mcp.log for errors.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    [
      ``,
      `✓ Daemon listening at http://127.0.0.1:${port}/mcp`,
      ``,
      `Register with your MCP hosts:`,
      ``,
      `  Claude Code:`,
      `    claude mcp remove projectionlab -s user 2>/dev/null || true`,
      `    claude mcp add --scope user --transport http projectionlab http://127.0.0.1:${port}/mcp`,
      ``,
      `  Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json):`,
      `    "projectionlab": {`,
      `      "command": "pl-mcp",`,
      `      "args": ["bridge"]`,
      `    }`,
      ``,
      `Then restart your MCP hosts and ask Claude: "sign me into ProjectionLab".`,
      ``,
      `Logs:    ${home}/Library/Logs/projectionlab-mcp.log`,
      `Uninstall: pl-mcp daemon uninstall`,
      ``,
    ].join("\n"),
  );
}

export async function uninstallDaemon(): Promise<void> {
  refuseOnNonDarwin();
  const home = os.homedir();
  const target = plistPath(home);
  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}/${LABEL}`;

  launchctl(["bootout", domain], { ignoreFailure: true });
  try {
    fs.unlinkSync(target);
    process.stderr.write(`Removed ${target}\n`);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
    process.stderr.write(`No plist at ${target} (already uninstalled).\n`);
  }
}
