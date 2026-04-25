import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function envPath(name: string, fallback: string): string {
  const v = process.env[name];
  if (!v) return fallback;
  return v.startsWith("~/") ? path.join(os.homedir(), v.slice(2)) : v;
}

export const config = {
  baseUrl: process.env.PROJECTIONLAB_BASE_URL || "https://app.projectionlab.com/",
  keyPath: envPath("PROJECTIONLAB_KEY_PATH", path.join(os.homedir(), ".config/projectionlab/key")),
  profileDir: envPath("PROJECTIONLAB_PROFILE_DIR", path.join(os.homedir(), ".config/projectionlab/profile")),
  backupsDir: envPath("PROJECTIONLAB_BACKUPS_DIR", path.join(os.homedir(), ".config/projectionlab/backups")),
  headless: (process.env.PROJECTIONLAB_HEADLESS ?? "true").toLowerCase() !== "false",
  apiBootTimeoutMs: 6000,
};

export function readApiKey(): string {
  try {
    const raw = fs.readFileSync(config.keyPath, "utf-8").trim();
    if (!raw) throw new Error("empty");
    return raw;
  } catch {
    const keyDir = path.dirname(config.keyPath);
    throw new Error(
      `ProjectionLab Plugin API key not found at ${config.keyPath}. ` +
        `Generate one in ProjectionLab Settings > Plugins, then save it with:\n` +
        `  mkdir -p ${keyDir} && printf '%s' 'YOUR_KEY' > ${config.keyPath} && chmod 600 ${config.keyPath}`,
    );
  }
}

export function apiKeyExists(): boolean {
  try {
    return fs.statSync(config.keyPath).size > 0;
  } catch {
    return false;
  }
}
