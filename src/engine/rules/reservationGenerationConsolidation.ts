/**
 * Rule: detect mixed-generation reservations on the same family that
 * fragment crawl coverage. Implements Jeannie Rule 4 (consolidation arm)
 * and references Jeannie Rule 5 in the narrative (3-year RI exchanges
 * dollar-for-dollar — no penalty for switching generation).
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";
import { normaliseSkuToken } from "../rates";
import { round2, formatMoney } from "./_helpers";
import { getFrameworkRule } from "../framework";

function isReservationRow(r: InvoiceRow): boolean {
  return /reservation/i.test(r.meter) || /reservation/i.test(r.serviceName);
}

function familyAndGen(meter: string): { family: string; generation: string } {
  const tok = normaliseSkuToken(meter);
  const m = tok.match(/^([a-z])\d+[a-z]*(?:_(v\d+))?/);
  return { family: m?.[1] ?? "?", generation: m?.[2] ?? "" };
}

export const reservationGenerationConsolidationRule: Rule = {
  id: "reservationGenerationConsolidation",
  name: "Reservation generation consolidation",
  framework: { rule: 4, quote: getFrameworkRule(4).statement },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const reservationRows = invoice.rows.filter(
      (r) => r.serviceName === "Virtual Machines" && isReservationRow(r)
    );
    if (reservationRows.length === 0) return null;

    type Bucket = { family: string; generations: Map<string, { cost: number; rows: InvoiceRow[] }> };
    const byFamily = new Map<string, Bucket>();
    for (const r of reservationRows) {
      const { family, generation } = familyAndGen(r.meter);
      const fam = byFamily.get(family) ?? { family, generations: new Map() };
      const gen = fam.generations.get(generation) ?? { cost: 0, rows: [] };
      gen.cost += r.cost;
      gen.rows.push(r);
      fam.generations.set(generation, gen);
      byFamily.set(family, fam);
    }

    const findings: Finding[] = [];
    let order = 1;
    for (const fam of byFamily.values()) {
      if (fam.generations.size < 2) continue;
      const gens = [...fam.generations.entries()];
      const evidence: EvidenceRow[] = gens.flatMap(([gen, b]) =>
        b.rows.slice(0, 5).map((r) => ({
          resourceId: r.resourceId,
          meter: r.meter,
          cost: round2(r.cost),
          reason: `Reservation on ${fam.family.toUpperCase()} ${gen || "(no gen)"} — fragments crawl across the family.`,
        }))
      );
      const totalCost = round2(gens.reduce((s, [, b]) => s + b.cost, 0));
      const genList = gens.map(([g]) => g || "(none)").join(", ");
      findings.push({
        id: `reservationGenerationConsolidation:${fam.family}`,
        category: "lever",
        jeannieRule: 4,
        order: order++,
        title: `Mixed-generation reservations on ${fam.family.toUpperCase()} family (${gens.length} generations)`,
        severity: "investigate",
        monthlySaving: null,
        annualSaving: null,
        currency: invoice.displayCurrency,
        confidence: "medium",
        evidence,
        narrative: {
          customer:
            `Your reservations for the ${fam.family.toUpperCase()} family span ${gens.length} different generations ` +
            `(${genList}). Reservations only crawl within a single generation, so this fragments your coverage. ` +
            `Consolidating to a single newer generation (typically v5) gives one pool that covers the whole family.`,
          consultant:
            `${fam.family.toUpperCase()} reservations spread across ${genList}. Total spend: ${formatMoney(totalCost, invoice.displayCurrency)}. ` +
            `Per Jeannie Rule 4, mixed generations don't crawl across each other. Consolidate to v5 (or newest stable) ` +
            `via Reservation Exchange — Jeannie Rule 5: every dollar transfers across exchanges, no penalty.`,
          informational:
            `Implements Jeannie Rule 4 (generation arm). Detection: same VM family appears with ≥2 distinct generations ` +
            `in reservation meters. Saving is not quantified — depends on per-VM utilisation profile after consolidation.`,
        },
        discoveryQuestions: [
          `Is the v5 (or newest stable) generation a viable target for this family in your regions?`,
          `Are any workloads pinned to a specific older generation for compliance / driver reasons?`,
        ],
        effort: "medium",
        requiresConfirmation: ["Confirm exchange windows and any pinning constraints"],
      });
    }
    return findings.length > 0 ? findings : null;
  },
};
