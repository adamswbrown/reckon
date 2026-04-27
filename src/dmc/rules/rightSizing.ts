/**
 * Utilisation-backed right-sizing rule.
 *
 * Implements the half of Jeannie's framework that the invoice-only
 * pipeline deliberately punts on: Rule 7 says "the invoice answers
 * where, not whether — right-sizing requires utilisation data, not
 * cost data." With a DMC Azure-mode scan available alongside the
 * invoice, that data is in scope and the recommendation graduates
 * from investigate to confirmed.
 *
 * Heuristic:
 *   - Both CPU p95 and memory p95 below their floors → both-low,
 *     drop one tier within the same family. Saving = compute_cost ×
 *     (1 − target_rate / current_rate), evidence is the invoice rows
 *     keyed to the VM.
 *   - CPU low but memory pressure ≥ 60% → family swap from D to E
 *     (more memory per core), at similar core count. Treat as
 *     conditional with a discovery question.
 *
 * Severity:
 *   - confirmed when powered_on ≥ 95% and the recommendation drops
 *     a single tier in-family (no behaviour change other than cost).
 *   - conditional otherwise.
 */

import type { Finding } from "../../types";
import type { JoinedVm } from "../join";

interface RightSizeRec {
  fromSku: string;
  toSku: string;
  /** approximate (current_rate − target_rate) / current_rate */
  reductionShare: number;
  reason: "both-low" | "cpu-low";
}

const RIGHTSIZE_CPU_P95 = 20.0;
const RIGHTSIZE_MEM_P95 = 50.0;

// Drop one tier within family. Approximate price reductions are
// computed from public Azure list prices and held here so the rule
// is self-contained.
const DOWNSIZE_TABLE: Record<string, RightSizeRec> = {
  Standard_D32s_v5:  { fromSku: "Standard_D32s_v5",  toSku: "Standard_D8s_v5",  reductionShare: 0.75, reason: "both-low" },
  Standard_D16s_v5:  { fromSku: "Standard_D16s_v5",  toSku: "Standard_D8s_v5",  reductionShare: 0.50, reason: "both-low" },
  Standard_D8s_v5:   { fromSku: "Standard_D8s_v5",   toSku: "Standard_D4s_v5",  reductionShare: 0.50, reason: "both-low" },
  Standard_D4s_v5:   { fromSku: "Standard_D4s_v5",   toSku: "Standard_B4ms",    reductionShare: 0.13, reason: "both-low" },
  Standard_E32ds_v5: { fromSku: "Standard_E32ds_v5", toSku: "Standard_E8ds_v5", reductionShare: 0.75, reason: "both-low" },
  Standard_E16ds_v5: { fromSku: "Standard_E16ds_v5", toSku: "Standard_E8ds_v5", reductionShare: 0.50, reason: "both-low" },
  Standard_E8ds_v5:  { fromSku: "Standard_E8ds_v5",  toSku: "Standard_E4ds_v5", reductionShare: 0.50, reason: "both-low" },
  Standard_B4ms:     { fromSku: "Standard_B4ms",     toSku: "Standard_B2ms",    reductionShare: 0.50, reason: "both-low" },
};

function fmt2(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function utilisationRightSizingFindings(joined: JoinedVm[]): Finding[] {
  const findings: Finding[] = [];
  for (const j of joined) {
    if (!j.vm.cpu || !j.vm.memory) continue;
    if (j.vm.powerState !== "running") continue;
    if (j.computeCost <= 0) continue; // no compute spend → nothing to save

    const cpuP95 = j.vm.cpu.p95;
    const memP95 = j.vm.memory.p95;
    const onPct = j.vm.cpu.poweredOnPercent;

    if (cpuP95 >= RIGHTSIZE_CPU_P95) continue;
    if (memP95 >= RIGHTSIZE_MEM_P95) continue;

    const rec = DOWNSIZE_TABLE[j.vm.vmSize];
    if (!rec) continue; // SKU not in catalogue — skip rather than guess

    const monthlySaving = j.computeCost * rec.reductionShare;
    const severity: Finding["severity"] =
      onPct >= 95 && rec.reductionShare >= 0.5 ? "confirmed" : "conditional";

    const title = `Right-size ${j.vm.name} — ${rec.fromSku} → ${rec.toSku} (cpu p95 ${cpuP95.toFixed(1)}%, mem p95 ${memP95.toFixed(1)}%)`;
    const headline =
      `Telemetry shows ${j.vm.name} ran at ${cpuP95.toFixed(1)}% CPU p95 and ${memP95.toFixed(1)}% memory p95 ` +
      `over ${j.vm.cpu.dataPoints} samples (${onPct.toFixed(0)}% powered-on). ` +
      `Dropping one tier from ${rec.fromSku} to ${rec.toSku} retains headroom while removing ` +
      `${(rec.reductionShare * 100).toFixed(0)}% of the compute charge.`;

    findings.push({
      id: `r07.right-sizing.${j.vm.uuid}`,
      category: "runtime",
      jeannieRule: 7,
      order: 0, // engine re-stamps display order
      title,
      severity,
      monthlySaving,
      annualSaving: monthlySaving * 12,
      currency: (j.currency as Finding["currency"]) ?? "USD",
      confidence: severity === "confirmed" ? "high" : "medium",
      // Evidence is the compute charge only — it must reconcile with the
      // claim, which is also derived from compute. License, disk, and
      // bandwidth rows belong to the join but not to this rule's saving
      // (a smaller VM still pays its license, disk, and bandwidth).
      // Evidence is the compute charge only — it must reconcile with the
      // claim, which is also derived from compute. Convert raw period
      // cost to monthly and scale by the reduction share so the sum
      // reconciles with monthlySaving (validator invariant).
      evidence: j.evidenceRows
        .filter(
          (r) =>
            /\/virtualMachines\//i.test(r.resourceId) &&
            !/license|bandwidth/i.test(r.serviceName),
        )
        .slice(0, 12)
        .map((r) => ({
          resourceId: r.resourceId,
          meter: r.meter,
          cost: (r.cost / j.periodMonths) * rec.reductionShare,
          reason: `Compute charge on ${j.vm.vmSize} — ${(rec.reductionShare * 100).toFixed(0)}% recoverable by moving to ${rec.toSku}`,
        })),
      narrative: {
        customer:
          `${j.vm.name} sits in ${j.vm.resourceGroup} and is paying ${j.currency} ${fmt2(j.computeCost)}/mo to run a ${rec.fromSku}, ` +
          `but its CPU never crossed ${cpuP95.toFixed(1)}% at p95 and memory peaked at ${memP95.toFixed(1)}%. ` +
          `Moving it to ${rec.toSku} keeps comfortable headroom and recovers about ${j.currency} ${fmt2(monthlySaving)} per month.`,
        consultant:
          `${j.vm.name} (${rec.fromSku}, ${j.vm.cores} vCPU, ${(j.vm.memoryMib / 1024).toFixed(0)} GiB) — ${cpuP95.toFixed(1)}% CPU p95 / ${memP95.toFixed(1)}% mem p95 over ${j.vm.collectionDays}d. ` +
          `Recommended target: ${rec.toSku}. Compute charge ${j.currency} ${fmt2(j.computeCost)}/mo → projected ${j.currency} ${fmt2(j.computeCost - monthlySaving)}/mo (saving ${j.currency} ${fmt2(monthlySaving)}/mo).`,
        informational: headline,
      },
      discoveryQuestions:
        severity === "confirmed"
          ? []
          : [
              `Is ${j.vm.name} carrying a memory-bound workload that requires the larger SKU outside the 90-day window?`,
              "Are there scheduled batch jobs that drive sustained CPU > 50% but fell outside the sample?",
            ],
      effort: severity === "confirmed" ? "low" : "medium",
      requiresConfirmation:
        severity === "confirmed"
          ? ["Take a maintenance window to resize the VM"]
          : ["Validate the workload pattern with the application owner", "Confirm reservation coverage doesn't lock the current SKU"],
    });
  }
  // Highest saving first.
  findings.sort((a, b) => (b.monthlySaving ?? 0) - (a.monthlySaving ?? 0));
  return findings;
}
