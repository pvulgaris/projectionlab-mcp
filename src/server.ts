/**
 * MCP server setup. Registers all ProjectionLab tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import {
  plExport,
  plGetAccounts,
  plGetAccount,
  plGetMilestones,
  plGetIncomeExpenses,
  plGetMonteCarlo,
  plGetWithdrawalStrategy,
  plGetTaxVariables,
} from "./tools/export.js";
import { plUpdateAccount } from "./tools/update.js";
import { plSnapshot, plListSnapshots, plSnapshotStats } from "./tools/snapshot.js";
import { plRestorePreview, plRestoreApply } from "./tools/restore.js";
import { plSessionStatus, plValidateKey, plReloadSession } from "./tools/session.js";

function jsonContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorContent(err: any) {
  const msg = String(err?.message ?? err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
  };
}

function safeTool<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      const result = await fn(args);
      return jsonContent(result);
    } catch (err) {
      return errorContent(err);
    }
  };
}

const planIdShape = {
  plan_id: z
    .string()
    .optional()
    .describe("Plan id to read from. Defaults to the active plan."),
};

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "projectionlab-mcp", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Diagnostics — always available, never throw.
  server.tool(
    "pl_session_status",
    "Diagnostics. Returns whether the API key file is present, whether the browser context is alive, whether the user is signed in, and whether the plugin API is registered. Never throws — call this first if anything looks off.",
    {},
    safeTool(plSessionStatus),
  );

  server.tool(
    "pl_validate_key",
    "Cheap auth probe — calls validateApiKey() upstream. Returns { valid: boolean, error?: string }. Use before bulk writes to fail fast on a stale key.",
    {},
    safeTool(plValidateKey),
  );

  server.tool(
    "pl_reload_session",
    "Close the in-memory browser context and re-launch a fresh one against the on-disk persistent profile. Use after the user runs `pl-mcp login` so newly-written Firebase cookies take effect — without this, the server keeps using the stale auth state from when its browser was first launched. Returns the same shape as pl_session_status.",
    {},
    safeTool(plReloadSession),
  );

  // Reads.
  server.tool(
    "pl_export",
    "High-level snapshot of the user's ProjectionLab plan: top-level counts, per-plan account-type breakdowns, withdrawal strategy id, filing status. Use this for orientation; reach for the scoped pl_get_* tools for specific data.",
    {},
    safeTool(plExport),
  );

  server.tool(
    "pl_get_accounts",
    "Today-account roster: every savings, investment, and asset account with its id (the id required by pl_update_account), name, type, owner, balance, and (where applicable) costBasis.",
    {},
    safeTool(plGetAccounts),
  );

  server.tool(
    "pl_get_account",
    "Look up a single account by id or by case-insensitive name substring. If multiple accounts match the name, returns them all as `candidates` so the caller can disambiguate with the user.",
    {
      id: z.string().optional().describe("Today-account id"),
      name: z.string().optional().describe("Case-insensitive substring of account name"),
    },
    safeTool(plGetAccount),
  );

  server.tool(
    "pl_get_milestones",
    "Plan milestones (title, year, age, type, completed).",
    planIdShape,
    safeTool(plGetMilestones),
  );

  server.tool(
    "pl_get_income_expenses",
    "Plan-level income and expense events (name, amount, frequency, owner, year range, type).",
    planIdShape,
    safeTool(plGetIncomeExpenses),
  );

  server.tool(
    "pl_get_monte_carlo",
    "Plan Monte Carlo settings.",
    planIdShape,
    safeTool(plGetMonteCarlo),
  );

  server.tool(
    "pl_get_withdrawal_strategy",
    "Active withdrawal strategy id, enabled state, spend mode, income config, and the nested config block for the active strategy.",
    planIdShape,
    safeTool(plGetWithdrawalStrategy),
  );

  server.tool(
    "pl_get_tax_variables",
    "Plan tax variables: filing status, capital gains and dividend modes/rates, income tax mode/rate, Medicare/IRMAA, TCJA reversion, estate, wealth tax mode.",
    planIdShape,
    safeTool(plGetTaxVariables),
  );

  // Write.
  server.tool(
    "pl_update_account",
    "Atomically update fields on one account. Auto-snapshots before mutating (so the change is reversible via pl_restore_apply). Pass either `id` (preferred) or `name` (case-insensitive substring; multi-match returns candidates instead of writing). `fields` may include `balance` and/or `costBasis`. The call snapshots, resolves the account, sends the update, then re-reads to verify; returns { verified, beforeFields, observedFields, writeError, snapshot }. ALWAYS confirm with the user before calling — name the exact account, field, current value, and new value, and wait for a literal 'yes'.",
    {
      id: z.string().optional().describe("Today-account id (from pl_get_accounts)"),
      name: z.string().optional().describe("Case-insensitive substring of account name (alternative to id)"),
      fields: z
        .record(z.unknown())
        .describe('Fields to update, e.g. { "balance": 125000 } or { "balance": 125000, "costBasis": 90000 }'),
      skip_snapshot: z
        .boolean()
        .optional()
        .describe(
          "If true, skip the pre-write snapshot. Only use when the caller has just snapshotted (e.g., pl_restore_apply doing a batch). Defaults to false.",
        ),
    },
    safeTool(plUpdateAccount),
  );

  // Snapshots & rollback.
  server.tool(
    "pl_snapshot",
    "Full exportData written to a timestamped JSON file under PROJECTIONLAB_BACKUPS_DIR (default ~/.config/projectionlab/backups/). Returns { path, bytes, takenAt }. The Plugin API key is automatically redacted before write. Use pl_restore_preview / pl_restore_apply to roll back from a snapshot.",
    {
      destination: z
        .string()
        .optional()
        .describe("Override the backup directory. Defaults to PROJECTIONLAB_BACKUPS_DIR."),
    },
    safeTool(plSnapshot),
  );

  server.tool(
    "pl_list_snapshots",
    "List recent snapshots (most recent first). Each entry includes { index, path, takenAt, ageSeconds, bytes }. Index 0 = most recent — useful as the n_back arg to pl_restore_preview / pl_restore_apply (which uses 1-based: n_back: 1 means index 0).",
    {
      limit: z.number().int().positive().optional().describe("Maximum entries to return (default 20)."),
    },
    safeTool(plListSnapshots),
  );

  server.tool(
    "pl_snapshot_stats",
    "Aggregate diagnostics over all snapshots in the backups directory: { count, totalBytes, oldest, newest }. Use to monitor disk growth and decide when to prune (no auto-prune in v1; prune manually with `rm`).",
    {},
    safeTool(plSnapshotStats),
  );

  server.tool(
    "pl_restore_preview",
    "Read-only preview of what pl_restore_apply would do. Provide exactly one of `snapshot_path`, `n_back` (1 = most recent snapshot), or `before_time` (ISO 8601). Returns { snapshot, changes, additions, deletions } where changes lists per-account before/after for balance and costBasis. Additions (accounts that exist now but not in the snapshot) and deletions (in snapshot, not now) are surfaced but not acted upon — restore is balance/costBasis only. Always preview before applying.",
    {
      snapshot_path: z.string().optional().describe("Absolute path to a snapshot JSON file."),
      n_back: z.number().int().positive().optional().describe("How many snapshots back to restore. 1 = most recent."),
      before_time: z.string().optional().describe("ISO 8601 timestamp; restores from the most recent snapshot taken at or before this time."),
    },
    safeTool(plRestorePreview),
  );

  server.tool(
    "pl_restore_apply",
    "Apply the restore previewed by pl_restore_preview. Same arg shape (exactly one of snapshot_path / n_back / before_time). Takes one pre-restore snapshot covering the entire batch, then re-applies each changed account's balance and (where present) costBasis via pl_update_account with skip_snapshot=true. Returns { snapshot, preRestoreSnapshot, applied, additions, deletions }. ALWAYS run pl_restore_preview first and confirm the change list with the user (literal 'yes') before calling this.",
    {
      snapshot_path: z.string().optional().describe("Absolute path to a snapshot JSON file."),
      n_back: z.number().int().positive().optional().describe("How many snapshots back to restore. 1 = most recent."),
      before_time: z.string().optional().describe("ISO 8601 timestamp; restores from the most recent snapshot taken at or before this time."),
    },
    safeTool(plRestoreApply),
  );

  return server;
}
