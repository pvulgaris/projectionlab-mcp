/**
 * Diagnostic / lifecycle tools.
 *
 * pl_session_status never throws — it's the tool you reach for when something
 * looks off. pl_validate_key is a cheap auth probe useful before bulk writes.
 * pl_reload_session forces a fresh browser context (needed after pl-mcp login
 * since the persistent profile changes on disk but the in-memory context
 * doesn't re-read it).
 */

import { statusReport, shutdown, loginInteractive, withLoginLock } from "../browser.js";
import { validateApiKey } from "../api.js";

export async function plSessionStatus() {
  return await statusReport();
}

export async function plValidateKey() {
  return await validateApiKey();
}

export async function plReloadSession() {
  await shutdown();
  // statusReport calls ensurePage internally, which lazy-launches a fresh
  // context that re-reads the persistent profile from disk.
  return await statusReport();
}

interface LoginArgs {
  timeout_seconds?: number;
}

/**
 * Run an interactive Firebase login from inside the daemon process. Shuts
 * down the headless Chromium so the headed login window has exclusive access
 * to the profile dir; the next read tool lazy-relaunches the headless
 * context against the freshly-signed-in profile.
 *
 * Other tool calls during login are rejected with `login_in_progress` so a
 * write doesn't race the auth swap.
 */
export async function plLoginInteractive(args: LoginArgs = {}) {
  return await withLoginLock(async () => {
    await shutdown();
    const timeoutMs = (args.timeout_seconds ?? 300) * 1000;
    await loginInteractive(timeoutMs);
    // statusReport lazy-launches the headless context against the new profile
    // and confirms the auth shows through end-to-end.
    return await statusReport();
  });
}
