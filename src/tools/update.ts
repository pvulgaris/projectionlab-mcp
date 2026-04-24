/**
 * pl_update_account — atomic single-account write with auto-snapshot.
 *
 * Every call snapshots first (so the change is reversible), then resolves
 * the target account, sends the update, and re-reads to verify. Pass
 * `skip_snapshot: true` only when the caller has already snapshotted (e.g.,
 * pl_restore_apply taking one snapshot for a whole batch).
 *
 * If the pre-write snapshot fails, the write is refused — better to surface
 * a snapshot failure than to mutate without a rollback point.
 */

import { exportData, updateAccount } from "../api.js";
import { plSnapshot } from "./snapshot.js";

interface UpdateArgs {
  id?: string;
  name?: string;
  fields: Record<string, unknown>;
  skip_snapshot?: boolean;
}

export async function plUpdateAccount(args: UpdateArgs) {
  if (!args.id && !args.name) {
    throw new Error("Provide either `id` or `name` to identify the account.");
  }
  if (!args.fields || Object.keys(args.fields).length === 0) {
    throw new Error("`fields` must contain at least one entry.");
  }

  // Pre-write snapshot. Hard-fail if it doesn't succeed.
  let snapshot: { path: string; takenAt: string } | undefined;
  if (!args.skip_snapshot) {
    try {
      const s = await plSnapshot();
      snapshot = { path: s.path, takenAt: s.takenAt };
    } catch (e: any) {
      throw new Error(
        `Pre-write snapshot failed; refusing to mutate. ${String(e?.message ?? e)}`,
      );
    }
  }

  // Resolve target account.
  const data = await exportData();
  const all = [
    ...(data.today?.savingsAccounts || []),
    ...(data.today?.investmentAccounts || []),
    ...(data.today?.assets || []),
  ];

  let target: any;
  if (args.id) {
    target = all.find((a) => a.id === args.id);
    if (!target) {
      return { resolved: false, error: `No account with id ${args.id}`, candidates: [], snapshot };
    }
  } else {
    const q = args.name!.toLowerCase().replace(/\s+/g, " ").trim();
    const matches = all.filter((a) => (a.name || "").toLowerCase().includes(q));
    if (matches.length === 0) {
      return { resolved: false, error: `No account name matches "${args.name}"`, candidates: [], snapshot };
    }
    if (matches.length > 1) {
      return {
        resolved: false,
        error: `Multiple accounts match "${args.name}" — disambiguate with id`,
        candidates: matches.map((a) => ({ id: a.id, name: a.name, type: a.type })),
        snapshot,
      };
    }
    target = matches[0];
  }

  // Strip undefined values — upstream rejects them.
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.fields)) {
    if (v !== undefined) fields[k] = v;
  }
  if (Object.keys(fields).length === 0) {
    throw new Error("All fields were undefined after stripping; nothing to write.");
  }

  // Capture before-values for the response.
  const before: Record<string, unknown> = {};
  for (const k of Object.keys(fields)) before[k] = target[k];

  const { writeError, observed } = await updateAccount(target.id, fields);

  const observedFields: Record<string, unknown> = {};
  if (observed) for (const k of Object.keys(fields)) observedFields[k] = observed[k];

  const verified = !writeError && Object.entries(fields).every(([k, v]) => observedFields[k] === v);

  return {
    resolved: true,
    accountId: target.id,
    accountName: target.name,
    accountType: target.type,
    requestedFields: fields,
    beforeFields: before,
    observedFields,
    writeError,
    verified,
    snapshot,
  };
}
