/**
 * Thin wrappers around window.projectionlabPluginAPI methods. Each function
 * takes care of injecting the API key (passed as a page.evaluate argument,
 * never string-interpolated, to avoid any escaping bugs) and returns the raw
 * upstream value. Field projection / scrubbing happens in the tool layer.
 */

import { getReadyPage } from "./browser.js";
import { readApiKey } from "./config.js";

export interface PLExport {
  meta?: any;
  plans?: any[];
  progress?: any;
  settings?: any;
  today?: {
    savingsAccounts?: any[];
    investmentAccounts?: any[];
    assets?: any[];
    debts?: any[];
    [k: string]: any;
  };
  [k: string]: any;
}

export async function exportData(): Promise<PLExport> {
  const page = await getReadyPage();
  const key = readApiKey();
  return await page.evaluate(async (k: string) => {
    return await (window as any).projectionlabPluginAPI.exportData({ key: k });
  }, key);
}

export interface UpdateAccountResult {
  writeError: string | null;
  observed: any | null;
}

export async function updateAccount(
  id: string,
  fields: Record<string, unknown>,
): Promise<UpdateAccountResult> {
  const page = await getReadyPage();
  const key = readApiKey();
  return await page.evaluate(
    async ({ k, accountId, payload }) => {
      const api = (window as any).projectionlabPluginAPI;
      let writeError: string | null = null;
      try {
        await api.updateAccount(accountId, payload, { key: k });
      } catch (e: any) {
        writeError = String(e?.message ?? e);
      }
      const data = await api.exportData({ key: k });
      const all = [
        ...(data.today?.savingsAccounts || []),
        ...(data.today?.investmentAccounts || []),
        ...(data.today?.assets || []),
      ];
      const acct = all.find((a: any) => a.id === accountId) || null;
      return { writeError, observed: acct };
    },
    { k: key, accountId: id, payload: fields },
  );
}

export interface RestorePlansResult {
  writeError: string | null;
}

/**
 * Whole-section replace of `plans`. The Plugin API's restorePlans internally
 * runs both a store-replace and a syncPlans pass; we can't separate them from
 * outside, so a single writeError covers both. Callers must verify via a
 * re-exportData() after this returns.
 */
export async function restorePlans(newPlans: any[]): Promise<RestorePlansResult> {
  const page = await getReadyPage();
  const key = readApiKey();
  return await page.evaluate(
    async ({ k, payload }) => {
      const api = (window as any).projectionlabPluginAPI;
      try {
        await api.restorePlans(payload, { key: k });
        return { writeError: null };
      } catch (e: any) {
        return { writeError: String(e?.message ?? e) };
      }
    },
    { k: key, payload: newPlans },
  );
}

export interface PluginApiSurface {
  hasRestorePlans: boolean;
  hasExportData: boolean;
  hasUpdateAccount: boolean;
}

/** Cheap probe: confirm the Plugin API still exposes the methods we need. */
export async function probePluginApi(): Promise<PluginApiSurface> {
  const page = await getReadyPage();
  return await page.evaluate(() => {
    const api = (window as any).projectionlabPluginAPI;
    return {
      hasRestorePlans: typeof api?.restorePlans === "function",
      hasExportData: typeof api?.exportData === "function",
      hasUpdateAccount: typeof api?.updateAccount === "function",
    };
  });
}

export async function validateApiKey(): Promise<{ valid: boolean; error?: string }> {
  const page = await getReadyPage();
  const key = readApiKey();
  return await page.evaluate(async (k: string) => {
    try {
      await (window as any).projectionlabPluginAPI.validateApiKey({ key: k });
      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: String(e?.message ?? e) };
    }
  }, key);
}
