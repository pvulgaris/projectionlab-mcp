/**
 * Playwright session manager. Holds a persistent-context browser and a single
 * ProjectionLab tab across the lifetime of the MCP server process.
 *
 * Lazy: nothing launches until the first call that needs a page. This keeps
 * `pl-mcp serve` startup instant and lets the diagnostic `pl_session_status`
 * tool report state without forcing a launch.
 *
 * Auth model: the persistent user-data-dir holds Firebase auth cookies.
 * `pl-mcp login` does the one-time interactive sign-in; the server reuses
 * those cookies.
 */

import { chromium, BrowserContext, Page } from "playwright";
import fs from "node:fs/promises";
import { config, apiKeyExists } from "./config.js";

let ctx: BrowserContext | null = null;
let page: Page | null = null;
let initPromise: Promise<Page> | null = null;

// Login mutex. While true, all other tool calls are rejected so the headed
// login Chromium can have exclusive access to the profile dir.
let loginInProgress = false;

export function isLoginInProgress(): boolean {
  return loginInProgress;
}

export async function withLoginLock<T>(fn: () => Promise<T>): Promise<T> {
  if (loginInProgress) {
    throw new Error("login_in_progress: another login is already running; retry shortly.");
  }
  loginInProgress = true;
  try {
    return await fn();
  } finally {
    loginInProgress = false;
  }
}

async function launch(headless: boolean): Promise<{ ctx: BrowserContext; page: Page }> {
  await fs.mkdir(config.profileDir, { recursive: true });
  const newCtx = await chromium.launchPersistentContext(config.profileDir, {
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const newPage = newCtx.pages()[0] ?? (await newCtx.newPage());
  await newPage.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
  return { ctx: newCtx, page: newPage };
}

async function ensurePage(): Promise<Page> {
  if (page && !page.isClosed() && ctx) return page;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const launched = await launch(config.headless);
    ctx = launched.ctx;
    page = launched.page;
    return page;
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Get a page where window.projectionlabPluginAPI is registered and the user
 * is signed in. Throws actionable errors otherwise.
 */
export async function getReadyPage(): Promise<Page> {
  if (loginInProgress) {
    throw new Error("login_in_progress: a login is currently in progress; retry shortly.");
  }
  const p = await ensurePage();
  if (!p.url().startsWith(config.baseUrl)) {
    await p.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
  }
  const status = await p.evaluate(async (timeoutMs: number) => {
    const fbKey = Object.keys(localStorage).find((k) => k.startsWith("firebase:authUser:"));
    if (!fbKey) return "signed_out" as const;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((window as any).projectionlabPluginAPI) return "ready" as const;
      await new Promise((r) => setTimeout(r, 200));
    }
    return "api_booting" as const;
  }, config.apiBootTimeoutMs);

  if (status === "signed_out") {
    throw new Error(
      "signed_out: ProjectionLab session is not signed in. Run `pl-mcp login` to sign in once; cookies will persist for future calls.",
    );
  }
  if (status === "api_booting") {
    throw new Error(
      "api_booting: window.projectionlabPluginAPI did not register within timeout. Confirm Plugins are enabled in ProjectionLab Settings > Plugins, then retry.",
    );
  }
  return p;
}

export async function shutdown(): Promise<void> {
  if (ctx) {
    try {
      await ctx.close();
    } catch {
      /* ignore */
    }
  }
  ctx = null;
  page = null;
}

/**
 * Interactive login flow. Forces headed Chromium so the user can complete
 * Firebase sign-in. Polls for Firebase auth in localStorage. On success,
 * persists by closing the context cleanly.
 */
export async function loginInteractive(timeoutMs = 5 * 60_000): Promise<void> {
  // Use a separate, headed context so this works even if a headless server
  // process happens to be holding the profile.
  await fs.mkdir(config.profileDir, { recursive: true });
  const interactive = await chromium.launchPersistentContext(config.profileDir, {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const p = interactive.pages()[0] ?? (await interactive.newPage());
  await p.goto(config.baseUrl, { waitUntil: "domcontentloaded" });

  process.stderr.write(
    "Sign in to ProjectionLab in the browser window. Waiting for authentication...\n",
  );

  const deadline = Date.now() + timeoutMs;
  let signedIn = false;
  while (Date.now() < deadline) {
    signedIn = await p
      .evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("firebase:authUser:")))
      .catch(() => false);
    if (signedIn) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!signedIn) {
    await interactive.close().catch(() => {});
    throw new Error("Login timed out after 5 minutes.");
  }

  process.stderr.write("Login detected. Persisting session...\n");
  // Give the SPA a beat to write any post-login state to localStorage/IDB.
  await new Promise((r) => setTimeout(r, 1500));
  await interactive.close();
  // Small extra wait so Chromium fully releases the profile lock files
  // before the next caller (likely the daemon's headless relaunch) opens them.
  await new Promise((r) => setTimeout(r, 500));
  process.stderr.write(`Done. Profile saved to: ${config.profileDir}\n`);
}

/**
 * Diagnostic snapshot of session state. Never throws — used by pl_session_status
 * to report what's wrong instead of failing the call.
 */
export async function statusReport() {
  const out = {
    keyPath: config.keyPath,
    profilePath: config.profileDir,
    backupsPath: config.backupsDir,
    baseUrl: config.baseUrl,
    headless: config.headless,
    apiKeyPresent: false,
    browserAlive: false,
    signedIn: false,
    pluginApiReady: false,
    error: undefined as string | undefined,
  };

  out.apiKeyPresent = apiKeyExists();

  try {
    const p = await ensurePage();
    out.browserAlive = !p.isClosed();
    // Poll the same way getReadyPage does, so the diagnostic reflects what
    // tool calls would actually see — not a one-shot snapshot that can race
    // the SPA's plugin-API registration.
    const probe = await p.evaluate(async (timeoutMs: number) => {
      const signedIn = Object.keys(localStorage).some((k) => k.startsWith("firebase:authUser:"));
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((window as any).projectionlabPluginAPI) return { signedIn, pluginApiReady: true };
        await new Promise((r) => setTimeout(r, 200));
      }
      return { signedIn, pluginApiReady: false };
    }, config.apiBootTimeoutMs);
    out.signedIn = probe.signedIn;
    out.pluginApiReady = probe.pluginApiReady;
  } catch (e: any) {
    out.error = String(e?.message ?? e);
  }

  return out;
}
