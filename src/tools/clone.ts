/**
 * pl_create_scenario — append a cloned plan (optionally with field-level
 * modifications) via the Plugin API's restorePlans whole-replace method.
 *
 * Safety story is layered:
 *   1. Arity probe — fail fast if PL renamed the methods.
 *   2. Freshness capture + re-check around the snapshot, so a concurrent UI
 *      edit can't race the write.
 *   3. Modification dry-run before snapshot: ambiguous/missing matches refuse
 *      before we mutate anything.
 *   4. Pre-call snapshot, refuse on snapshot failure (mirrors update.ts).
 *   5. Append-only payload (existing plans + 1) so a payload bug can't drop
 *      a plan.
 *   6. Verification of neighbor invariants: all original plan ids present
 *      with original lastUpdated/simKey; active plan unchanged; today.*
 *      rosters and balances unchanged. Modifications observed in the clone.
 *
 * Plans hold in-plan back-references (priorities→accounts/income,
 * expenses→income, computedMilestones→priorities/accounts). Without a
 * two-pass id remap, those refs would dangle and PL would silently drop
 * priority routing / milestone tracking. buildIdRemap + rewriteInPlanRefs
 * handle this.
 */

import { randomUUID } from "node:crypto";
import { exportData, probePluginApi, restorePlans } from "../api.js";
import { plSnapshot } from "./snapshot.js";

const REMAPPED_COLLECTIONS = ["income", "expenses", "assets", "accounts", "priorities"] as const;
type RemappedCollection = (typeof REMAPPED_COLLECTIONS)[number];

const STRUCTURAL_FIELDS = new Set([
  "id",
  "key",
  "_meta",
  "planPath",
  "assetId",
  "accountId",
  "incomeStreamId",
  "deductFromIncomeId",
  "goalId",
  "refId",
]);

interface MatchSpec {
  id?: string;
  name?: string;
  type?: string;
  assetId?: string;
  accountId?: string;
}

interface SetEventFieldsModification {
  kind: "set_event_fields";
  collection: RemappedCollection;
  match: MatchSpec;
  fields: Record<string, unknown>;
}

type Modification = SetEventFieldsModification;

export interface CreateScenarioArgs {
  source_plan_id?: string;
  new_name: string;
  modifications?: Modification[];
}

interface ResolvedMod {
  index: number;
  modification: Modification;
  status: "ok" | "none" | "ambiguous";
  sourceEvent?: any;
  candidates?: Array<{ id: string; name: string; type: string }>;
}

function resolveSourcePlan(data: any, id?: string): any | null {
  const plans = data.plans || [];
  if (id) return plans.find((p: any) => p.id === id) ?? null;
  return plans.find((p: any) => p.active) ?? plans[0] ?? null;
}

function matches(event: any, spec: MatchSpec): boolean {
  if (spec.id !== undefined && event.id !== spec.id) return false;
  if (spec.name !== undefined) {
    const n = (event.name ?? "").toLowerCase();
    if (!n.includes(spec.name.toLowerCase())) return false;
  }
  if (spec.type !== undefined && event.type !== spec.type) return false;
  if (spec.assetId !== undefined && event.assetId !== spec.assetId) return false;
  if (spec.accountId !== undefined && event.accountId !== spec.accountId) return false;
  return true;
}

function resolveModifications(sourcePlan: any, mods: Modification[]): ResolvedMod[] {
  return mods.map((m, index) => {
    const events: any[] = sourcePlan?.[m.collection]?.events ?? [];
    const hits = events.filter((e) => matches(e, m.match));
    if (hits.length === 0) return { index, modification: m, status: "none" };
    if (hits.length > 1) {
      return {
        index,
        modification: m,
        status: "ambiguous",
        candidates: hits.map((e) => ({ id: e.id, name: e.name, type: e.type })),
      };
    }
    return { index, modification: m, status: "ok", sourceEvent: hits[0] };
  });
}

function buildIdRemap(plan: any): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of REMAPPED_COLLECTIONS) {
    for (const e of plan?.[c]?.events ?? []) {
      if (typeof e.id === "string") map.set(e.id, randomUUID());
    }
  }
  return map;
}

function rewriteInPlanRefs(plan: any, map: Map<string, string>): void {
  const remap = (id: any): any =>
    typeof id === "string" && map.has(id) ? map.get(id)! : id;

  for (const c of REMAPPED_COLLECTIONS) {
    for (const e of plan?.[c]?.events ?? []) {
      e.id = remap(e.id);
    }
  }
  for (const p of plan?.priorities?.events ?? []) {
    if (typeof p.accountId === "string" && map.has(p.accountId)) p.accountId = map.get(p.accountId);
    if (typeof p.incomeStreamId === "string" && map.has(p.incomeStreamId)) {
      p.incomeStreamId = map.get(p.incomeStreamId);
    }
  }
  for (const e of plan?.expenses?.events ?? []) {
    if (typeof e.deductFromIncomeId === "string" && map.has(e.deductFromIncomeId)) {
      e.deductFromIncomeId = map.get(e.deductFromIncomeId);
    }
  }
  for (const m of plan?.computedMilestones ?? []) {
    if (typeof m.goalId === "string" && map.has(m.goalId)) {
      m.goalId = map.get(m.goalId);
      m.id = `goal:${m.goalId}`;
    }
    for (const c of m.criteria ?? []) {
      if (typeof c.refId === "string" && map.has(c.refId)) c.refId = map.get(c.refId);
    }
  }
}

interface VerifyInput {
  preWritePlans: any[];
  preWriteToday: any;
  postWritePlans: any[];
  postWriteToday: any;
  newPlanId: string;
  newName: string;
  resolved: ResolvedMod[];
  idRemap: Map<string, string>;
}

function verifyClone(input: VerifyInput): { verified: boolean; violations: string[] } {
  const violations: string[] = [];
  const preIds = new Set(input.preWritePlans.map((p) => p.id));
  const postIds = new Set(input.postWritePlans.map((p) => p.id));

  for (const id of preIds) {
    if (!postIds.has(id)) violations.push(`pre-existing plan ${id} disappeared after write`);
  }

  const added = input.postWritePlans.filter((p) => !preIds.has(p.id));
  if (added.length !== 1) {
    violations.push(`expected exactly 1 new plan; got ${added.length}`);
  } else if (added[0].id !== input.newPlanId) {
    violations.push(`new plan id mismatch: expected ${input.newPlanId}, got ${added[0].id}`);
  } else if (added[0].name !== input.newName) {
    violations.push(`new plan name mismatch: expected ${input.newName}, got ${added[0].name}`);
  }

  for (const orig of input.preWritePlans) {
    const post = input.postWritePlans.find((p) => p.id === orig.id);
    if (!post) continue;
    if (post.lastUpdated !== orig.lastUpdated) {
      violations.push(`plan ${orig.id} lastUpdated changed (${orig.lastUpdated} → ${post.lastUpdated})`);
    }
    if (post.simKey !== orig.simKey) {
      violations.push(`plan ${orig.id} simKey changed (${orig.simKey} → ${post.simKey})`);
    }
  }

  const preActive = input.preWritePlans.find((p) => p.active);
  const postActive = input.postWritePlans.find((p) => p.active);
  if (preActive?.id !== postActive?.id) {
    violations.push(`active plan changed (${preActive?.id} → ${postActive?.id})`);
  }

  const todayLabels = ["savingsAccounts", "investmentAccounts", "assets"] as const;
  for (const label of todayLabels) {
    const pre = input.preWriteToday?.[label] ?? [];
    const post = input.postWriteToday?.[label] ?? [];
    const preMap = new Map(pre.map((r: any) => [r.id, r.balance]));
    const postMap = new Map(post.map((r: any) => [r.id, r.balance]));
    for (const [id, balance] of preMap) {
      if (!postMap.has(id)) violations.push(`today.${label} ${id} disappeared`);
      else if (postMap.get(id) !== balance) {
        violations.push(`today.${label} ${id} balance changed (${balance} → ${postMap.get(id)})`);
      }
    }
    if (postMap.size !== preMap.size) {
      violations.push(`today.${label} count changed (${preMap.size} → ${postMap.size})`);
    }
  }

  const newPlan = input.postWritePlans.find((p) => p.id === input.newPlanId);
  if (newPlan) {
    for (const r of input.resolved) {
      if (r.status !== "ok" || !r.sourceEvent) continue;
      const expectedId = input.idRemap.get(r.sourceEvent.id);
      const cloneEvent = newPlan?.[r.modification.collection]?.events?.find(
        (e: any) => e.id === expectedId,
      );
      if (!cloneEvent) {
        violations.push(`modification #${r.index}: cloned event not found at remapped id`);
        continue;
      }
      for (const [k, v] of Object.entries(r.modification.fields)) {
        if (cloneEvent[k] !== v) {
          violations.push(
            `modification #${r.index} ${r.modification.collection}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(cloneEvent[k])}`,
          );
        }
      }
    }
  }

  return { verified: violations.length === 0, violations };
}

export async function plCreateScenario(args: CreateScenarioArgs) {
  // 1. Arity probe.
  const surface = await probePluginApi();
  if (!surface.hasRestorePlans || !surface.hasExportData) {
    throw new Error(
      `Plugin API surface missing required methods. Probe: ${JSON.stringify(surface)}`,
    );
  }

  const newName = (args.new_name ?? "").trim();
  if (!newName) throw new Error("`new_name` must be a non-empty string.");

  // 2. Freshness capture.
  const initial = await exportData();
  const sourcePlan = resolveSourcePlan(initial, args.source_plan_id);
  if (!sourcePlan) {
    throw new Error(
      args.source_plan_id
        ? `No plan with id ${args.source_plan_id}`
        : "No active plan found.",
    );
  }
  const freshness = {
    metaLastUpdated: initial.meta?.lastUpdated,
    sourceLastUpdated: sourcePlan.lastUpdated,
    sourceSchema: sourcePlan.schema,
  };

  // 3. Modification dry-run.
  const modifications = args.modifications ?? [];
  for (const [i, m] of modifications.entries()) {
    if (m.kind !== "set_event_fields") {
      throw new Error(`Modification #${i}: unsupported kind ${JSON.stringify((m as any).kind)}`);
    }
    if (!REMAPPED_COLLECTIONS.includes(m.collection)) {
      throw new Error(`Modification #${i}: unsupported collection ${JSON.stringify(m.collection)}`);
    }
    for (const k of Object.keys(m.fields ?? {})) {
      if (STRUCTURAL_FIELDS.has(k)) {
        throw new Error(
          `Modification #${i}: field "${k}" is structural and cannot be set via set_event_fields.`,
        );
      }
    }
  }
  const resolved = resolveModifications(sourcePlan, modifications);
  const unresolved = resolved.filter((r) => r.status !== "ok");
  if (unresolved.length) {
    return {
      resolved: false,
      error: "One or more modifications could not be uniquely resolved.",
      perModification: resolved.map((r) => ({
        index: r.index,
        status: r.status,
        match: r.modification.match,
        candidates: r.candidates,
      })),
    };
  }

  // 4. Name collision check.
  const existingNames = (initial.plans ?? []).map((p: any) =>
    (p.name ?? "").trim().toLowerCase(),
  );
  if (existingNames.includes(newName.toLowerCase())) {
    throw new Error(`A plan named "${newName}" already exists.`);
  }

  // 5. Pre-call snapshot.
  let snapshot: { path: string; takenAt: string };
  try {
    const s = await plSnapshot();
    snapshot = { path: s.path, takenAt: s.takenAt };
  } catch (e: any) {
    throw new Error(`Pre-write snapshot failed; refusing to mutate. ${String(e?.message ?? e)}`);
  }

  // 6. Freshness re-check.
  const recheck = await exportData();
  const sourceRecheck = recheck.plans?.find((p: any) => p.id === sourcePlan.id);
  if (!sourceRecheck) {
    return {
      resolved: true,
      verified: false,
      error: "Source plan disappeared between freshness capture and write.",
      snapshot,
    };
  }
  if (
    recheck.meta?.lastUpdated !== freshness.metaLastUpdated ||
    sourceRecheck.lastUpdated !== freshness.sourceLastUpdated ||
    sourceRecheck.schema !== freshness.sourceSchema
  ) {
    return {
      resolved: true,
      verified: false,
      error: "Plan changed between freshness capture and write. Re-export and retry.",
      snapshot,
    };
  }

  // 7. Build the clone.
  const idRemap = buildIdRemap(sourcePlan);
  const clone = structuredClone(sourcePlan);
  rewriteInPlanRefs(clone, idRemap);

  const newPlanId = randomUUID();
  clone.id = newPlanId;
  clone.simKey =
    Math.max(0, ...(recheck.plans ?? []).map((p: any) => p.simKey ?? 0)) + 1;
  if (clone.meta && typeof clone.meta === "object" && "runKey" in clone.meta) {
    clone.meta.runKey =
      Math.max(0, ...(recheck.plans ?? []).map((p: any) => p.meta?.runKey ?? 0)) + 1;
  }
  clone.name = newName;
  clone.lastUpdated = Date.now();
  clone.active = false;

  // Apply modifications to the clone.
  const modSummary: Array<{
    index: number;
    collection: string;
    matched: { id: string; name: string; type: string };
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }> = [];
  for (const r of resolved) {
    if (r.status !== "ok" || !r.sourceEvent) continue;
    const expectedId = idRemap.get(r.sourceEvent.id);
    const cloneEvent = clone[r.modification.collection]?.events?.find(
      (e: any) => e.id === expectedId,
    );
    if (!cloneEvent) {
      throw new Error(
        `Internal: cloned event missing for source id ${r.sourceEvent.id} in ${r.modification.collection}`,
      );
    }
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(r.modification.fields)) {
      before[field] = cloneEvent[field];
      cloneEvent[field] = value;
      after[field] = value;
      cloneEvent._meta ??= {};
      cloneEvent._meta.overriddenFields ??= {};
      cloneEvent._meta.overriddenFields[field] = true;
    }
    modSummary.push({
      index: r.index,
      collection: r.modification.collection,
      matched: {
        id: r.sourceEvent.id,
        name: r.sourceEvent.name,
        type: r.sourceEvent.type,
      },
      before,
      after,
    });
  }

  // 8. Write.
  const newPlans = [...(recheck.plans ?? []), clone];
  const { writeError } = await restorePlans(newPlans);
  if (writeError) {
    return {
      resolved: true,
      verified: false,
      writeError,
      snapshot,
      note: "restorePlans failed. State may be partial — verify in PL UI before retrying.",
    };
  }

  // 9. Verify.
  const after = await exportData();
  const verification = verifyClone({
    preWritePlans: recheck.plans ?? [],
    preWriteToday: recheck.today,
    postWritePlans: after.plans ?? [],
    postWriteToday: after.today,
    newPlanId,
    newName,
    resolved,
    idRemap,
  });

  return {
    resolved: true,
    verified: verification.verified,
    invariantViolations: verification.violations,
    scenarioId: newPlanId,
    scenarioName: newName,
    sourcePlanId: sourcePlan.id,
    sourcePlanName: sourcePlan.name,
    idRemap: Object.fromEntries(idRemap),
    modifications: modSummary,
    snapshot,
    note: "pl_restore_apply restores balance/costBasis only — to undo this scenario, call pl_delete_scenario.",
    nextStep: `Open ProjectionLab → Plans → Compare to see "${newName}" vs "${sourcePlan.name}".`,
  };
}
