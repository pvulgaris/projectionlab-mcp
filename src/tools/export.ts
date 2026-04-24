/**
 * Read tools. Each fetches exportData (with the scrubber applied) and
 * projects the fields relevant to the question. Field selections are ported
 * from the existing skill's drill-down snippets.
 */

import { exportData, type PLExport } from "../api.js";
import { scrub } from "../scrub.js";

function activePlan(data: PLExport): any {
  const plans = data.plans || [];
  return plans.find((p: any) => p.active) ?? plans[0] ?? {};
}

function planById(data: PLExport, planId?: string): any {
  if (!planId) return activePlan(data);
  return (data.plans || []).find((p: any) => p.id === planId) ?? {};
}

export async function plExport() {
  const data = scrub(await exportData());
  const plans = (data.plans || []).map((p: any) => {
    const accts = p.accounts?.events || [];
    const byType: Record<string, number> = {};
    for (const a of accts) byType[a.type || "unknown"] = (byType[a.type || "unknown"] || 0) + 1;
    return {
      id: p.id,
      name: p.name,
      active: p.active,
      counts: {
        accounts: accts.length,
        income: p.income?.events?.length ?? 0,
        expenses: p.expenses?.events?.length ?? 0,
        priorities: p.priorities?.events?.length ?? 0,
        assets: p.assets?.events?.length ?? 0,
        milestones: p.milestones?.length ?? 0,
      },
      accountTypeBreakdown: byType,
      withdrawalStrategy: p.withdrawalStrategy?.strategy,
      filingStatus: p.variables?.filingStatus,
    };
  });
  return {
    today: {
      savingsAccounts: data.today?.savingsAccounts?.length ?? 0,
      investmentAccounts: data.today?.investmentAccounts?.length ?? 0,
      assets: data.today?.assets?.length ?? 0,
      debts: data.today?.debts?.length ?? 0,
      filingStatus: data.today?.filingStatus,
      partnerStatus: data.today?.partnerStatus,
    },
    plans,
  };
}

export async function plGetAccounts() {
  const data = scrub(await exportData());
  const assemble = (arr: any[] | undefined, bucket: string) =>
    (arr || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      owner: a.owner,
      balance: a.balance,
      ...(a.costBasis !== undefined ? { costBasis: a.costBasis } : {}),
      bucket,
    }));
  return [
    ...assemble(data.today?.savingsAccounts, "savings"),
    ...assemble(data.today?.investmentAccounts, "investment"),
    ...assemble(data.today?.assets, "asset"),
  ];
}

export async function plGetAccount(args: { id?: string; name?: string }) {
  if (!args.id && !args.name) {
    throw new Error("Provide either `id` or `name`.");
  }
  const all = await plGetAccounts();
  if (args.id) {
    const match = all.find((a) => a.id === args.id);
    return match ? { match } : { match: null, candidates: [] };
  }
  const q = args.name!.toLowerCase().replace(/\s+/g, " ").trim();
  const candidates = all.filter((a) => (a.name || "").toLowerCase().includes(q));
  if (candidates.length === 1) return { match: candidates[0] };
  return { match: null, candidates };
}

export async function plGetMilestones(args: { plan_id?: string } = {}) {
  const data = await exportData();
  const p = planById(data, args.plan_id);
  return (p.milestones || []).map((m: any) => ({
    title: m.title,
    year: m.year,
    age: m.age,
    type: m.type,
    completed: m.completed,
  }));
}

export async function plGetIncomeExpenses(args: { plan_id?: string } = {}) {
  const data = await exportData();
  const p = planById(data, args.plan_id);
  const summarize = (e: any) => ({
    name: e.name,
    amount: e.amount,
    frequency: e.frequency,
    owner: e.owner,
    startYear: e.startYear,
    endYear: e.endYear,
    type: e.type,
  });
  return {
    income: (p.income?.events || []).map(summarize),
    expenses: (p.expenses?.events || []).map(summarize),
  };
}

export async function plGetMonteCarlo(args: { plan_id?: string } = {}) {
  const data = await exportData();
  const p = planById(data, args.plan_id);
  return p.montecarlo ?? null;
}

export async function plGetWithdrawalStrategy(args: { plan_id?: string } = {}) {
  const data = await exportData();
  const p = planById(data, args.plan_id);
  const ws = p.withdrawalStrategy ?? {};
  return {
    strategy: ws.strategy,
    enabled: ws.enabled,
    spendMode: ws.spendMode,
    income: ws.income,
    config: ws.strategy ? ws[ws.strategy] : undefined,
  };
}

export async function plGetTaxVariables(args: { plan_id?: string } = {}) {
  const data = await exportData();
  const p = planById(data, args.plan_id);
  const v = p.variables ?? {};
  return {
    filingStatus: v.filingStatus,
    estimateTaxes: v.estimateTaxes,
    capGainsMode: v.capGainsMode,
    capGainsTaxRate: v.capGainsTaxRate,
    dividendTaxMode: v.dividendTaxMode,
    dividendTaxRate: v.dividendTaxRate,
    incomeTaxMode: v.incomeTaxMode,
    incomeTaxModifier: v.incomeTaxModifier,
    effectiveIncomeTaxRate: v.effectiveIncomeTaxRate,
    localIncomeTaxRate: v.localIncomeTaxRate,
    medicare: v.medicare,
    irmaa: v.irmaa,
    tcjaReversion: v.tcjaReversion,
    estate: v.estate,
    wealthTaxMode: v.wealthTaxMode,
  };
}
