/**
 * Rule: dormantVmCluster — clusters apparently-dormant VMs by RG, computes
 * AMBIENT cost (everything else in the same RG: disks, NICs, public IPs,
 * Defender, Log Analytics, etc.). Implements Jeannie Rule 6 ("they sprawl,
 * they don't dim") and Rule 10 (severity stays `investigate`).
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney } from "./_helpers";
import { getFrameworkRule } from "../framework";

export const dormantVmClusterRule: Rule = {
  id: "dormantVmCluster",
  name: "Dormant VM cluster — ambient cost analysis",
  framework: { rule: 6, quote: getFrameworkRule(6).statement },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    // RG → { vmIds (with $0 compute), ambient cost (non-VM cost in RG) }
    type Bucket = {
      rg: string;
      dormantVmIds: Set<string>;
      ambientCost: number;
      ambientRows: EvidenceRow[];
    };
    const byRg = new Map<string, Bucket>();
    // First pass: identify VMs with $0 compute.
    const vmComputeCost = new Map<string, number>();
    for (const r of invoice.rows) {
      if (r.resourceType !== "microsoft.compute/virtualmachines") continue;
      if (r.serviceName !== "Virtual Machines") continue;
      vmComputeCost.set(r.resourceId, (vmComputeCost.get(r.resourceId) ?? 0) + r.cost);
    }
    const dormantVmIds = new Set(
      [...vmComputeCost.entries()].filter(([, c]) => c === 0).map(([id]) => id)
    );
    if (dormantVmIds.size === 0) return null;

    // Identify dormant VMs' RGs and accumulate ambient cost in those RGs.
    const dormantRgs = new Set<string>();
    for (const r of invoice.rows) {
      if (dormantVmIds.has(r.resourceId)) dormantRgs.add(r.resourceGroupName);
    }
    for (const r of invoice.rows) {
      if (!dormantRgs.has(r.resourceGroupName)) continue;
      const b = byRg.get(r.resourceGroupName) ?? {
        rg: r.resourceGroupName,
        dormantVmIds: new Set<string>(),
        ambientCost: 0,
        ambientRows: [],
      };
      if (dormantVmIds.has(r.resourceId)) {
        b.dormantVmIds.add(r.resourceId);
      } else if (r.cost > 0) {
        b.ambientCost += r.cost;
        if (b.ambientRows.length < 5) {
          b.ambientRows.push({
            resourceId: r.resourceId,
            meter: `${r.serviceName} / ${r.meter}`,
            cost: round2(r.cost),
            reason: `Ambient cost in RG with ${b.dormantVmIds.size}+ dormant VMs.`,
          });
        }
      }
      byRg.set(r.resourceGroupName, b);
    }

    const findings: Finding[] = [];
    let order = 1;
    for (const b of byRg.values()) {
      if (b.dormantVmIds.size === 0 || b.ambientCost <= 0) continue;
      findings.push({
        id: `dormantVmCluster:${b.rg}`,
        category: "runtime",
        jeannieRule: 6,
        order: order++,
        title: `Dormant VM cluster in '${b.rg}' — ${b.dormantVmIds.size} VMs off, ${formatMoney(round2(b.ambientCost), invoice.displayCurrency)} ambient`,
        severity: "investigate",
        monthlySaving: null,
        annualSaving: null,
        currency: invoice.displayCurrency,
        confidence: "medium",
        evidence: b.ambientRows,
        narrative: {
          customer:
            `Resource group '${b.rg}' has ${b.dormantVmIds.size} servers that appear to be switched off, but ` +
            `the disks, networking and monitoring around them are still costing ` +
            `${formatMoney(round2(b.ambientCost), invoice.displayCurrency)} a month. ` +
            `Worth checking whether this group is kept for disaster recovery or just forgotten.`,
          consultant:
            `RG '${b.rg}': ${b.dormantVmIds.size} dormant VMs, ${formatMoney(round2(b.ambientCost), invoice.displayCurrency)} ambient cost ` +
            `(disks/NICs/IPs/Defender/Log Analytics). Per Jeannie Rule 6 — sprawl signal. Decision tree: ` +
            `if DR → tag and document; if forgotten → decommission group as a unit.`,
          informational:
            `Detection: VM rows with computeCost === 0 grouped by RG; ambient cost = sum of non-VM rows in that RG. ` +
            `Severity 'investigate' (Rule 10) — DR pattern is healthy and looks identical from cost alone.`,
        },
        discoveryQuestions: [
          `Is RG '${b.rg}' a DR / standby cluster, or has the workload been retired?`,
          `If retired, what is preventing whole-RG decommissioning?`,
        ],
        effort: "medium",
        requiresConfirmation: ["Owner sign-off before any RG-level decommission"],
      });
    }
    return findings.length > 0 ? findings : null;
  },
};
