/**
 * pl-mcp bridge — stdio MCP server that proxies frames to the running HTTP daemon.
 *
 * Solves a Claude Desktop config quirk: the desktop config only accepts stdio
 * MCP entries, so connecting to the daemon usually requires the third-party
 * `mcp-remote` package as a stdio<->HTTP bridge. We ship our own equivalent
 * here so the desktop config is just `{"command": "pl-mcp", "args": ["bridge"]}`.
 *
 * The bridge owns no Chromium state and acquires no profile lock — it's a
 * transparent JSON-RPC proxy. Stateless: one stdio in, one HTTP daemon out.
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const DEFAULT_PORT = 7301;

function resolvePort(): number {
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === "--port" && process.argv[i + 1]) {
      const n = parseInt(process.argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
    }
  }
  if (process.env.PROJECTIONLAB_PORT) {
    const n = parseInt(process.env.PROJECTIONLAB_PORT, 10);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  }
  return DEFAULT_PORT;
}

async function probeDaemon(url: URL): Promise<{ ok: true } | { ok: false; reason: string }> {
  // The daemon's /mcp returns 405 on GET (stateless mode). Any HTTP response
  // means the daemon is alive; ECONNREFUSED means it isn't.
  try {
    await fetch(url, { method: "GET" });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

export async function runBridge(): Promise<void> {
  const port = resolvePort();
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  const probe = await probeDaemon(url);
  if (!probe.ok) {
    process.stderr.write(
      `pl-mcp bridge: cannot reach daemon at ${url.href}\n` +
        `Is it running? Try:\n  pl-mcp daemon install\n\n` +
        `(${probe.reason})\n`,
    );
    process.exit(2);
  }

  const httpClient = new StreamableHTTPClientTransport(url);
  const stdio = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await httpClient.close().catch(() => {});
    await stdio.close().catch(() => {});
    process.exit(code);
  };

  stdio.onmessage = (msg) => {
    httpClient.send(msg).catch((e) => {
      process.stderr.write(`pl-mcp bridge: send to daemon failed: ${String(e?.message ?? e)}\n`);
    });
  };
  httpClient.onmessage = (msg) => {
    stdio.send(msg).catch((e) => {
      process.stderr.write(`pl-mcp bridge: send to host failed: ${String(e?.message ?? e)}\n`);
    });
  };

  stdio.onclose = () => shutdown(0);
  httpClient.onclose = () => shutdown(0);
  stdio.onerror = (e) => {
    process.stderr.write(`pl-mcp bridge: stdio error: ${String(e?.message ?? e)}\n`);
  };
  httpClient.onerror = (e) => {
    process.stderr.write(`pl-mcp bridge: daemon connection error: ${String(e?.message ?? e)}\n`);
  };

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => shutdown(0));
  }

  await httpClient.start();
  await stdio.start();
}
