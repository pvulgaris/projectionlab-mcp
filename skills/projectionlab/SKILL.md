---
name: projectionlab
description: Read, snapshot, and update the user's ProjectionLab plan via the projectionlab-mcp server. Use when the user asks about their ProjectionLab plan — balances, milestones, income/expenses, Monte Carlo, withdrawal strategy, tax variables — wants to back up plan state, or wants to update an account balance or cost basis.
---

# ProjectionLab

The `mcp__projectionlab__*` tools read and update the user's plan via a persistent headless Playwright session. Auth (Firebase) and the Plugin API key are owned by the MCP server — this skill is workflow guidance only.

## When to use

- Plan inspection: "what's in my ProjectionLab plan?", "show my balances", "how am I tracking on FIRE?", "what milestones do I have?"
- Plan settings: questions about Monte Carlo, withdrawal strategy, tax variables.
- Backup: any "back up", "snapshot", "save", or "archive" PL request.
- Updates: a balance or cost-basis change for a single account.
- Sync intent: when the user wants to reconcile PL with another source.

## Read flow

1. Default to `pl_export` for an orientation (counts, structure).
2. Drill down with the scoped tools when the user wants specifics:
   - balances → `pl_get_accounts` (or `pl_get_account` for one)
   - milestones → `pl_get_milestones`
   - income/expenses → `pl_get_income_expenses`
   - Monte Carlo → `pl_get_monte_carlo`
   - withdrawal strategy → `pl_get_withdrawal_strategy`
   - taxes → `pl_get_tax_variables`
3. When summarizing, prefer structure and counts. Include specific balances only when the user asks.

## Write flow — `pl_update_account`

Every write requires explicit per-call user confirmation. No silent writes, no batched writes across multiple accounts.

1. Resolve the account first if the user gave a name. Use `pl_get_account` (`name: "..."`); if multiple candidates come back, list them and ask the user to pick by id.
2. Render this exact confirmation block in prose and wait for a literal `yes`:
   ```
   Update proposed:
     account: <name> (id: <id>, type: <type>)
     field:   <field>
     current: <current value>
     new:     <new value>
   Confirm? (yes/no)
   ```
   Anything other than `yes` aborts. Don't infer consent from "sure", "ok", "go ahead".
3. Call `pl_update_account` with `id` (preferred) and the `fields` object.
4. Check `verified === true` and `observedFields` matches the requested values. On any mismatch or `writeError`, surface it loudly — silent drift is the worst outcome.

`pl_update_account` is atomic across the fields you pass. Updating both `balance` and `costBasis` in one call halves round-trips. Only include `costBasis` for accounts that have it (investment accounts only — savings and assets reject it).

## Snapshot flow

`pl_snapshot` writes a full export to `~/.config/projectionlab/backups/` with mode 0600. The Plugin API key is auto-redacted. Manual snapshots are mostly redundant — every `pl_update_account` already auto-snapshots — but useful for archiving a known-good moment outside any mutation.

Use `pl_list_snapshots` to show the user recent snapshots; `pl_snapshot_stats` for disk/count diagnostics.

## Undo / rollback flow

When the user says "undo," "revert," "go back," or asks to restore to a known-good state:

1. **Preview first.** Call `pl_restore_preview` with exactly one of:
   - `{ n_back: 1 }` — most recent snapshot (i.e., undo the last mutation)
   - `{ n_back: N }` — N snapshots back
   - `{ before_time: "2026-04-24T12:00:00Z" }` — restore to state at or before this time
   - `{ snapshot_path: "..." }` — explicit file path

2. **Render the change list to the user**, listing each per-account before→after for balance and (where present) costBasis. Surface `additions` (accounts that exist now but not in the snapshot) and `deletions` (in snapshot, not now) so the user knows what *isn't* being restored. Use this confirmation block:
   ```
   Restore proposed (from snapshot taken <takenAt>):
     <account name> (<type>): balance <before> → <after>
     <account name> (<type>): balance <before> → <after>, costBasis <before> → <after>
     ...
   Not restoring (additions): <list or "none">
   Not restoring (deletions): <list or "none">
   Confirm? (yes/no)
   ```

3. Wait for a literal `yes`. Anything else aborts.

4. **Apply.** Call `pl_restore_apply` with the same args. It takes one pre-restore snapshot (so the restore itself is reversible) and re-applies each change via `pl_update_account` with `skip_snapshot: true`.

5. Verify every entry in `applied[]` has `verified: true` and no `writeError`. Surface any failures loudly.

**Limits to be explicit about:**
- Restore is balance + costBasis only — the same write surface as `pl_update_account`.
- Cannot restore deleted accounts or un-create added accounts (`updateAccount` can't create or delete).
- Cannot restore non-balance state (milestones, plan settings, withdrawal strategy, taxes). The snapshot file remains the user's reference for those — direct them to fix in the PL UI if needed.

## Batch updates

For multi-account updates (e.g., reconciling PL against an external source the user provides):

1. Match the source's account names against `pl_get_accounts` by case-insensitive substring; surface unmatched accounts before proceeding.
2. For each matched pair where balances differ, render the diff and ask the user to confirm the *batch* (not per-account). Wait for a literal `yes` to the bulk apply.
3. **Snapshot strategy:** call `pl_snapshot` once at the start of the batch, then call `pl_update_account` with `skip_snapshot: true` for each account. This avoids per-account snapshot churn (~94KB each) and makes the whole batch undoable as a single unit via `pl_restore_apply({ snapshot_path: <the batch snapshot> })` or `pl_restore_apply({ n_back: <count of writes since> })`.
4. After the batch, verify each `pl_update_account` returned `verified: true`. Surface any failures loudly — partial batches happen.

## Error guidance

- `signed_out` — the user's PL session is not signed in. Call `pl_login_interactive`. A headed browser window opens; tell the user to sign in. The tool returns when sign-in completes. No separate CLI command, no host restarts.
- `login_in_progress` — another login is running (multiple tools called `pl_login_interactive` at once, or a previous login hasn't finished). Wait a few seconds and retry.
- `api_booting` — almost always Plugins are disabled in PL Settings > Plugins.
- `Invalid Plugin API Key` — stale key. Tell the user to regenerate in PL Settings > Plugins and overwrite `~/.config/projectionlab/key`.
- Any other error — call `pl_session_status` for diagnostics; it never throws.
- Before a batch of writes, you can call `pl_validate_key` as a cheap probe — it confirms the saved key is current without touching plan state.

## Rules

- Never echo the Plugin API key in user-facing prose.
- Never call `pl_update_account` without an explicit `yes` to the standard confirmation block.
- Restore-style operations (whole-section replace) are not exposed by this MCP and must not be reached for. If a user asks for a bulk reset, do it as a series of single-account `pl_update_account` calls.
