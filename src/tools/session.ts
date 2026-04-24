/**
 * Diagnostic / lifecycle tools.
 *
 * pl_session_status never throws — it's the tool you reach for when something
 * looks off. pl_validate_key is a cheap auth probe useful before bulk writes.
 * pl_reload_session forces a fresh browser context (needed after pl-mcp login
 * since the persistent profile changes on disk but the in-memory context
 * doesn't re-read it).
 */

import { statusReport, shutdown } from "../browser.js";
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
