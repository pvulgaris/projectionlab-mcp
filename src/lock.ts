/**
 * Profile singleton lock.
 *
 * Two pl-mcp processes (or a serve + a login) opening the same persistent
 * Chromium profile dir results in LevelDB store corruption — Chromium can't
 * coordinate concurrent writes, and the cookie/IndexedDB stores end up with
 * stale or partial reads. The most common symptom: signedIn:false even
 * though valid Firebase auth cookies are on disk.
 *
 * We enforce one-process-per-profile by writing a PID file at the root of
 * the profile dir. acquireLock() refuses to start if another live process
 * already holds the lock. Stale locks (PID is dead) are cleaned up.
 *
 * Caller is responsible for releasing the lock on graceful shutdown. Hard
 * crashes leave a stale lock that the next acquire cleans up automatically.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const LOCK_FILENAME = ".pl-mcp-server.pid";

function lockPath(): string {
  return path.join(config.profileDir, LOCK_FILENAME);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // ESRCH = no such process; EPERM = exists but signal denied (still alive).
    if (e?.code === "EPERM") return true;
    return false;
  }
}

export interface LockConflict {
  message: string;
  conflictingPid: number;
}

/**
 * Try to acquire the profile lock. Returns null on success, or a conflict
 * descriptor if another live process holds the lock. Never throws.
 */
export function tryAcquireLock(): LockConflict | null {
  fs.mkdirSync(config.profileDir, { recursive: true });
  const file = lockPath();
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (isPidAlive(pid)) {
      return {
        conflictingPid: pid,
        message:
          `Profile ${config.profileDir} is already in use by pl-mcp PID ${pid}.\n` +
          `Multiple Chromium instances on one profile corrupt the auth state.\n` +
          `Stop the other process first:\n` +
          `  kill ${pid}\n` +
          `or kill all pl-mcp processes:\n` +
          `  pkill -f projectionlab-mcp`,
      };
    }
    // Stale lock — fall through and overwrite.
  }
  fs.writeFileSync(file, String(process.pid));
  return null;
}

/**
 * Release the lock if (and only if) we're the owner. Safe to call repeatedly
 * and from process-exit handlers.
 */
export function releaseLock(): void {
  try {
    const file = lockPath();
    const content = fs.readFileSync(file, "utf-8").trim();
    if (parseInt(content, 10) === process.pid) fs.unlinkSync(file);
  } catch {
    /* lock already gone or unreadable — fine */
  }
}

/**
 * Look at the current lock without modifying it. For diagnostics.
 */
export function readLockOwner(): { pid: number; alive: boolean } | null {
  try {
    const content = fs.readFileSync(lockPath(), "utf-8").trim();
    const pid = parseInt(content, 10);
    return { pid, alive: isPidAlive(pid) };
  } catch {
    return null;
  }
}
