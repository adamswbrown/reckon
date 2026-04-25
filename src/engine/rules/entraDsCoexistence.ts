/**
 * Rule: Entra Domain Services coexisting with VMs that look like Domain
 * Controllers. Per Jeannie Rule 10, severity stays `investigate` and the
 * engine NEVER recommends a deletion — this is purely a surfacing pattern.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney } from "./_helpers";

const DC_TOKENS = ["-dc", "_dc", "dc01", "dc02", "domaincontroller", "addc", "adds"];

export const entraDsCoexistenceRule: Rule = {
  id: "entraDsCoexistence",
  name: "Entra Domain Services coexisting with DC VMs",
  framework: { rule: 10, quote: "Investigate-only — never recommend action on identity infrastructure from cost alone." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const entraDs = invoice.rows.filter(
      (r) => r.serviceName === "Microsoft Entra Domain Services" && r.cost > 0
    );
    const dcVms = invoice.rows.filter((r) => {
      if (r.resourceType !== "microsoft.compute/virtualmachines") return false;
      const lc = r.resourceId.toLowerCase();
      return DC_TOKENS.some((t) => lc.includes(t));
    });
    if (entraDs.length === 0 || dcVms.length === 0) return null;

    const entraCost = round2(entraDs.reduce((s, r) => s + r.cost, 0));
    const dcCost = round2(dcVms.reduce((s, r) => s + r.cost, 0));
    const evidence: EvidenceRow[] = [
      ...entraDs.slice(0, 5).map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `Entra Domain Services line.`,
      })),
      ...dcVms.slice(0, 5).map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `VM with DC-pattern name.`,
      })),
    ];

    return [{
      id: "entraDsCoexistence",
      category: "anomaly",
      jeannieRule: 10,
      order: 1,
      title: `Entra Domain Services + DC VM coexistence (${formatMoney(entraCost, invoice.displayCurrency)} + ${formatMoney(dcCost, invoice.displayCurrency)})`,
      severity: "investigate",
      monthlySaving: null,
      annualSaving: null,
      currency: invoice.displayCurrency,
      confidence: "low",
      evidence,
      narrative: {
        customer:
          `Both Entra Domain Services (managed Active Directory) and ${dcVms.length} domain-controller-shaped ` +
          `VMs are running. There may be a deliberate reason — but it is worth a conversation about whether ` +
          `one of the two could be retired.`,
        consultant:
          `Entra DS (${formatMoney(entraCost, invoice.displayCurrency)}/period) and ${dcVms.length} VMs with DC-pattern names ` +
          `(${formatMoney(dcCost, invoice.displayCurrency)}). Per Jeannie Rule 10 — DO NOT recommend an action; ` +
          `identity infrastructure is too easy to break from a cost view.`,
        informational:
          `Detection: presence of both Entra DS service rows and VMs whose name matches DC token patterns. ` +
          `Severity 'investigate' — Rule 10 prevents this from feeding any aggregated saving total. ` +
          `The engine deliberately offers NO recommendation here; the discovery question is the deliverable.`,
      },
      discoveryQuestions: [
        `Why does the estate need both Entra Domain Services and self-managed Domain Controllers?`,
        `Is one a transition state (e.g. migration in progress) or are both required for distinct workloads?`,
      ],
      effort: "high",
      requiresConfirmation: ["Identity team review — no action without architecture sign-off"],
    }];
  },
};
