/**
 * Snapshot-based rollback. Two tools:
 *
 * pl_restore_preview — read-only diff between a snapshot and current state.
 *   Classifies each account into changes / additions / deletions. Always
 *   safe to call; never mutates.
 *
 * pl_restore_apply — runs the same preview, then re-applies each changed
 *   account's balance and (where present) costBasis via plUpdateAccount with
 *   skip_snapshot=true so the whole batch costs one pre-restore snapshot.
 *
 * Both delegate snapshot resolution to resolveSnapshot in ./snapshot, which
 * accepts exactly one of { snapshot_path, n_back, before_time }.
 */

import fs from "node:fs/promises";
import { exportData } from "../api.js";
import { plSnapshot, resolveSnapshot, type ResolveSnapshotArgs } from "./snapshot.js";
import { plUpdateAccount } from "./update.js";

interface AccountRow {
  id: string;
  name: string;
  type: string;
  balance?: number;
  costBasis?: number;
}

function rosterFromExport(data: any): AccountRow[] {
  const out: AccountRow[] = [];
  for (const a of data.today?.savingsAccounts || []) {
    out.push({ id: a.id, name: a.name, type: a.type, balance: a.balance });
  }
  for (const a of data.today?.investmentAccounts || []) {
    out.push({
      id: a.id,
      name: a.name,
      type: a.type,
      balance: a.balance,
      costBasis: a.costBasis,
    });
  }
  for (const a of data.today?.assets || []) {
    out.push({ id: a.id, name: a.name, type: a.type, balance: a.balance });
  }
  return out;
}

interface PreviewChange {
  accountId: string;
  accountName: string;
  type: string;
  before: { balance?: number; costBasis?: number };
  after: { balance?: number; costBasis?: number };
}

export async function plRestorePreview(args: ResolveSnapshotArgs) {
  const entry = await resolveSnapshot(args);
  const snapshotJson = JSON.parse(await fs.readFile(entry.path, "utf-8"));
  const snapAccounts = rosterFromExport(snapshotJson);
  const currentData = await exportData();
  const currAccounts = rosterFromExport(currentData);

  const snapById = new Map(snapAccounts.map((a) => [a.id, a]));
  const currById = new Map(currAccounts.map((a) => [a.id, a]));

  const changes: PreviewChange[] = [];
  for (const [id, snap] of snapById) {
    const curr = currById.get(id);
    if (!curr) continue; // deletion — handled below
    const balanceChanged = snap.balance !== undefined && curr.balance !== snap.balance;
    const cbChanged = snap.costBasis !== undefined && curr.costBasis !== snap.costBasis;
    if (balanceChanged || cbChanged) {
      changes.push({
        accountId: id,
        accountName: snap.name,
        type: snap.type,
        before: {
          ...(balanceChanged ? { balance: curr.balance } : {}),
          ...(cbChanged ? { costBasis: curr.costBasis } : {}),
        },
        after: {
          ...(balanceChanged ? { balance: snap.balance } : {}),
          ...(cbChanged ? { costBasis: snap.costBasis } : {}),
        },
      });
    }
  }

  const additions = currAccounts
    .filter((a) => !snapById.has(a.id))
    .map((a) => ({ accountId: a.id, accountName: a.name, type: a.type }));
  const deletions = snapAccounts
    .filter((a) => !currById.has(a.id))
    .map((a) => ({ accountId: a.id, accountName: a.name, type: a.type }));

  return {
    snapshot: { path: entry.path, takenAt: entry.takenAt },
    changes,
    additions,
    deletions,
  };
}

interface AppliedRow {
  accountId: string;
  accountName: string;
  verified: boolean;
  observedFields: Record<string, unknown> | null;
  writeError: string | null;
}

export async function plRestoreApply(args: ResolveSnapshotArgs) {
  const preview = await plRestorePreview(args);
  if (preview.changes.length === 0) {
    return {
      ...preview,
      preRestoreSnapshot: null,
      applied: [] as AppliedRow[],
      note: "No changes to apply — current state already matches snapshot.",
    };
  }

  // Single pre-restore snapshot covering the whole batch.
  const preSnapshot = await plSnapshot();

  const applied: AppliedRow[] = [];
  for (const change of preview.changes) {
    const fields: Record<string, unknown> = {};
    if ("balance" in change.after) fields.balance = change.after.balance;
    if ("costBasis" in change.after) fields.costBasis = change.after.costBasis;
    const result = await plUpdateAccount({
      id: change.accountId,
      fields,
      skip_snapshot: true,
    });
    applied.push({
      accountId: change.accountId,
      accountName: change.accountName,
      verified: !!(result as any).verified,
      observedFields: (result as any).observedFields ?? null,
      writeError: (result as any).writeError ?? null,
    });
  }

  return {
    snapshot: preview.snapshot,
    preRestoreSnapshot: { path: preSnapshot.path, takenAt: preSnapshot.takenAt },
    additions: preview.additions,
    deletions: preview.deletions,
    applied,
  };
}
