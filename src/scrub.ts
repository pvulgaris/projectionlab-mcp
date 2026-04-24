/**
 * Defensive scrubbing of PL exportData payloads. Two concerns:
 *
 * 1. The Plugin API key is embedded in `settings.plugins.apiKey` — never let it
 *    leave this process unredacted (logs, snapshots, MCP responses).
 * 2. The Claude tool-result content scanner rewrites JWT-shaped values as
 *    `[BLOCKED]`. The historical case is `meta.version`. We strip such fields
 *    before returning rather than fighting the scanner.
 */

const SCANNER_PRONE_PATHS: Array<string[]> = [
  ["meta", "version"],
];

export function scrub<T>(input: T): T {
  if (input == null) return input;
  const cloned = structuredClone(input);
  redactKey(cloned);
  for (const path of SCANNER_PRONE_PATHS) deletePath(cloned, path);
  return cloned;
}

function redactKey(obj: any): void {
  if (obj?.settings?.plugins?.apiKey) obj.settings.plugins.apiKey = "[redacted]";
}

function deletePath(obj: any, path: string[]): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[path[i]];
  }
  if (cur && typeof cur === "object") delete cur[path[path.length - 1]];
}
