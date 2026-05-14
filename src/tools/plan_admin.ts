/**
 * Plan-level admin tools.
 *
 * pl_delete_scenario — remove a plan by id. id-only (no name lookup) because
 * plan deletion is irreversible: snapshot rollback does not restore plans, so
 * the agent must look up the id via pl_export first and surface it to the
 * user before constructing the call. Same safety gates as clone.ts.
 *
 * pl_get_plan_events — read tool. Returns the raw events array for a
 * collection on a plan (default: active plan), with all fields including ids
 * and back-references so callers can construct modifications for
 * pl_create_scenario.
 */

import { exportData, probePluginApi, restorePlans } from "../api.js";
import { plSnapshot } from "./snapshot.js";

const EVENT_COLLECTIONS = ["income", "expenses", "assets", "accounts", "priorities"] as const;
type EventCollection = (typeof EVENT_COLLECTIONS)[number];

function activePlan(data: any): any | null {
  const plans = data.plans || [];
  return plans.find((p: any) => p.active) ?? plans[0] ?? null;
}

export interface GetPlanEventsArgs {
  plan_id?: string;
  collection?: EventCollection;
}

export async function plGetPlanEvents(args: GetPlanEventsArgs = {}) {
  const data = await exportData();
  const plan = args.plan_id
    ? (data.plans || []).find((p: any) => p.id === args.plan_id)
    : activePlan(data);
  if (!plan) {
    throw new Error(
      args.plan_id ? `No plan with id ${args.plan_id}` : "No active plan found.",
    );
  }
  const out: Record<string, any[]> = {};
  const cols: readonly EventCollection[] = args.collection
    ? [args.collection]
    : EVENT_COLLECTIONS;
  for (const c of cols) {
    out[c] = plan?.[c]?.events ?? [];
  }
  return { planId: plan.id, planName: plan.name, active: !!plan.active, events: out };
}

export interface DeleteScenarioArgs {
  id: string;
}

export async function plDeleteScenario(args: DeleteScenarioArgs) {
  if (!args.id || typeof args.id !== "string") {
    throw new Error("`id` is required (string). Look up via pl_export before calling.");
  }

  // 1. Arity probe.
  const surface = await probePluginApi();
  if (!surface.hasRestorePlans || !surface.hasExportData) {
    throw new Error(
      `Plugin API surface missing required methods. Probe: ${JSON.stringify(surface)}`,
    );
  }

  // 2. Freshness capture.
  const initial = await exportData();
  const plans = initial.plans ?? [];
  const target = plans.find((p: any) => p.id === args.id);
  if (!target) throw new Error(`No plan with id ${args.id}`);
  if (target.active) {
    throw new Error(
      `Plan "${target.name}" is active; switch to a different plan in PL UI before deleting.`,
    );
  }
  if (plans.length <= 1) {
    throw new Error("Cannot delete the only remaining plan; at least one plan must exist.");
  }
  const freshness = {
    metaLastUpdated: initial.meta?.lastUpdated,
    targetLastUpdated: target.lastUpdated,
  };

  // 3. Pre-call snapshot.
  let snapshot: { path: string; takenAt: string };
  try {
    const s = await plSnapshot();
    snapshot = { path: s.path, takenAt: s.takenAt };
  } catch (e: any) {
    throw new Error(`Pre-write snapshot failed; refusing to mutate. ${String(e?.message ?? e)}`);
  }

  // 4. Freshness re-check.
  const recheck = await exportData();
  const targetRecheck = recheck.plans?.find((p: any) => p.id === args.id);
  if (!targetRecheck) {
    return {
      verified: false,
      error: "Target plan disappeared between freshness capture and write.",
      snapshot,
    };
  }
  if (
    recheck.meta?.lastUpdated !== freshness.metaLastUpdated ||
    targetRecheck.lastUpdated !== freshness.targetLastUpdated
  ) {
    return {
      verified: false,
      error: "Plan changed between freshness capture and write. Re-export and retry.",
      snapshot,
    };
  }

  // Count target's events for the response (snapshot the count before delete).
  const counts = {
    income: targetRecheck.income?.events?.length ?? 0,
    expenses: targetRecheck.expenses?.events?.length ?? 0,
    assets: targetRecheck.assets?.events?.length ?? 0,
    accounts: targetRecheck.accounts?.events?.length ?? 0,
    priorities: targetRecheck.priorities?.events?.length ?? 0,
  };

  // 5. Write — filter out the target plan.
  const newPlans = (recheck.plans ?? []).filter((p: any) => p.id !== args.id);
  const { writeError } = await restorePlans(newPlans);
  if (writeError) {
    return {
      verified: false,
      writeError,
      snapshot,
      note: "restorePlans failed. State may be partial — verify in PL UI before retrying.",
    };
  }

  // 6. Verify.
  const after = await exportData();
  const afterIds = new Set((after.plans ?? []).map((p: any) => p.id));
  const violations: string[] = [];
  if (afterIds.has(args.id)) violations.push(`target plan ${args.id} still present after delete`);
  for (const p of recheck.plans ?? []) {
    if (p.id === args.id) continue;
    if (!afterIds.has(p.id)) violations.push(`pre-existing plan ${p.id} disappeared`);
  }
  const preActive = (recheck.plans ?? []).find((p: any) => p.active);
  const postActive = (after.plans ?? []).find((p: any) => p.active);
  if (preActive?.id !== postActive?.id) {
    violations.push(`active plan changed (${preActive?.id} → ${postActive?.id})`);
  }

  return {
    verified: violations.length === 0,
    invariantViolations: violations,
    deletedPlanId: args.id,
    deletedPlanName: target.name,
    eventCounts: counts,
    plansRemaining: after.plans?.length ?? 0,
    snapshot,
    note: "Deletion is permanent; snapshot rollback does NOT restore deleted plans.",
  };
}
