/**
 * Diagnostic / lifecycle tools.
 *
 * pl_session_status never throws — it's the tool you reach for when something
 * looks off. pl_validate_key is a cheap auth probe useful before bulk writes.
 */

import { statusReport } from "../browser.js";
import { validateApiKey } from "../api.js";

export async function plSessionStatus() {
  return await statusReport();
}

export async function plValidateKey() {
  return await validateApiKey();
}
