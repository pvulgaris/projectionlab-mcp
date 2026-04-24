/**
 * Snapshot tools and helpers.
 *
 * pl_snapshot writes a full exportData JSON to PROJECTIONLAB_BACKUPS_DIR.
 * Snapshots double as the rollback timeline: every mutation auto-snapshots
 * first, and the restore tools re-apply balances from any snapshot file.
 *
 * The filesystem is the source of truth. Filenames embed a sortable timestamp
 * for human readability, but ordering and `takenAt` come from the file's
 * mtime so we don't need to parse filenames.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { exportData } from "../api.js";
import { scrub } from "../scrub.js";
import { config } from "../config.js";

const FILE_PATTERN = /^projectionlab-.*\.json$/;

export interface SnapshotEntry {
  path: string;
  takenAt: string;
  bytes: number;
  mtimeMs: number;
}

async function listEntries(): Promise<SnapshotEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(config.backupsDir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const matches = names.filter((n) => FILE_PATTERN.test(n));
  const stats = await Promise.all(
    matches.map(async (n) => {
      const p = path.join(config.backupsDir, n);
      const s = await fs.stat(p);
      return {
        path: p,
        takenAt: new Date(s.mtimeMs).toISOString(),
        bytes: s.size,
        mtimeMs: s.mtimeMs,
      };
    }),
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats;
}

interface SnapshotArgs {
  destination?: string;
}

export async function plSnapshot(args: SnapshotArgs = {}) {
  const data = scrub(await exportData());
  const json = JSON.stringify(data, null, 2);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `projectionlab-${ts}.json`;
  const dir = args.destination ?? config.backupsDir;
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, filename);
  await fs.writeFile(out, json, { mode: 0o600 });
  const stat = await fs.stat(out);
  return {
    path: out,
    bytes: Buffer.byteLength(json, "utf-8"),
    takenAt: new Date(stat.mtimeMs).toISOString(),
  };
}

interface ListSnapshotsArgs {
  limit?: number;
}

export async function plListSnapshots(args: ListSnapshotsArgs = {}) {
  const limit = args.limit ?? 20;
  const entries = await listEntries();
  const now = Date.now();
  return entries.slice(0, limit).map((e, i) => ({
    index: i,
    path: e.path,
    takenAt: e.takenAt,
    ageSeconds: Math.round((now - e.mtimeMs) / 1000),
    bytes: e.bytes,
  }));
}

export async function plSnapshotStats() {
  const entries = await listEntries();
  if (entries.length === 0) {
    return {
      count: 0,
      totalBytes: 0,
      backupsDir: config.backupsDir,
      oldest: null,
      newest: null,
    };
  }
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const oldest = entries[entries.length - 1];
  const newest = entries[0];
  return {
    count: entries.length,
    totalBytes,
    backupsDir: config.backupsDir,
    oldest: { path: oldest.path, takenAt: oldest.takenAt, bytes: oldest.bytes },
    newest: { path: newest.path, takenAt: newest.takenAt, bytes: newest.bytes },
  };
}

export interface ResolveSnapshotArgs {
  snapshot_path?: string;
  n_back?: number;
  before_time?: string;
}

/**
 * Resolve a snapshot from one of three reference forms. Throws on ambiguous
 * args, invalid types, or no matching snapshot.
 */
export async function resolveSnapshot(args: ResolveSnapshotArgs): Promise<SnapshotEntry> {
  const provided = [args.snapshot_path != null, args.n_back != null, args.before_time != null].filter(Boolean).length;
  if (provided !== 1) {
    throw new Error("Provide exactly one of `snapshot_path`, `n_back`, or `before_time`.");
  }
  const entries = await listEntries();
  if (entries.length === 0) {
    throw new Error(`No snapshots found in ${config.backupsDir}.`);
  }
  if (args.snapshot_path != null) {
    const match = entries.find((e) => e.path === args.snapshot_path);
    if (!match) throw new Error(`Snapshot not found: ${args.snapshot_path}`);
    return match;
  }
  if (args.n_back != null) {
    const n = args.n_back;
    if (!Number.isInteger(n) || n < 1) {
      throw new Error("`n_back` must be a positive integer (1 = most recent snapshot).");
    }
    if (n > entries.length) {
      throw new Error(`Only ${entries.length} snapshot(s) available; cannot go back ${n}.`);
    }
    return entries[n - 1];
  }
  // before_time
  const t = Date.parse(args.before_time!);
  if (Number.isNaN(t)) {
    throw new Error(`Invalid before_time: "${args.before_time}". Use ISO 8601 (e.g. 2026-04-24T12:00:00Z).`);
  }
  const match = entries.find((e) => e.mtimeMs <= t);
  if (!match) {
    throw new Error(`No snapshots taken at or before ${args.before_time}.`);
  }
  return match;
}
