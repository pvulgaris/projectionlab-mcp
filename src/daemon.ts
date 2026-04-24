/**
 * pl-mcp daemon — long-running Streamable HTTP server.
 *
 * All MCP clients (Claude Code, Claude Desktop, etc.) connect to this one
 * instance, so they share a single Chromium and a single auth state. The
 * daemon is meant to be managed by launchd (see examples/install-daemon.sh)
 * but works fine when run manually too.
 *
 * Stateless Streamable HTTP per the MCP spec: each request gets a fresh
 * McpServer + transport pair. PL-specific state (browser context, snapshot
 * dir, lock) lives as module-level singletons that all requests share.
 */

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 7301;

export function runDaemon(port?: number): void {
  const resolvedPort =
    port ?? (process.env.PROJECTIONLAB_PORT ? parseInt(process.env.PROJECTIONLAB_PORT, 10) : DEFAULT_PORT);

  if (!Number.isFinite(resolvedPort) || resolvedPort <= 0 || resolvedPort > 65535) {
    throw new Error(`Invalid port: ${resolvedPort}`);
  }

  const app = createMcpExpressApp({ host: HOST });

  app.post("/mcp", async (req, res) => {
    const server = createServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (e: any) {
      process.stderr.write(`pl-mcp daemon: error handling request: ${String(e?.message ?? e)}\n`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode: server-initiated streaming (GET) and session deletion (DELETE) aren't applicable.
  const methodNotAllowed = (_req: any, res: any) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless transport)." },
      id: null,
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(resolvedPort, HOST, () => {
    process.stderr.write(`pl-mcp daemon listening on http://${HOST}:${resolvedPort}/mcp\n`);
  });
}
