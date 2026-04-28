/**
 * Rule: detect mixed-generation reservations on the same family that
 * fragment crawl coverage. Implements Jeannie Rule 4 (consolidation arm)
 * and references Jeannie Rule 5 in the narrative (3-year RI exchanges
 * dollar-for-dollar — no penalty for switching generation).
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";
import { parseSkuToken, storageVariantLabel } from "../rates";
import { round2, formatMoney } from "./_helpers";
import { getFrameworkRule } from "../framework";

function isReservationRow(r: InvoiceRow): boolean {
  return /reservation/i.test(r.meter) || /reservation/i.test(r.serviceName);
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

    // Group by (family, storage). The storage axis matters because Instance
    // Size Flexibility cannot crawl across SSD/HDD — D4 v3 (HDD) and D4s v5
    // (SSD) are different reservation namespaces, so it would be wrong to
    // recommend exchanging one for the other as a consolidation play.
    type Bucket = {
      family: string;
      storage: "ssd" | "hdd";
      generations: Map<string, { cost: number; rows: InvoiceRow[] }>;
    };
    const byFamilyStorage = new Map<string, Bucket>();
    for (const r of reservationRows) {
      const parsed = parseSkuToken(r.meter);
      const storage = storageVariantLabel(parsed);
      const key = `${parsed.family}|${storage}`;
      const fam = byFamilyStorage.get(key) ?? { family: parsed.family, storage, generations: new Map() };
      const gen = fam.generations.get(parsed.generation) ?? { cost: 0, rows: [] };
      gen.cost += r.cost;
      gen.rows.push(r);
      fam.generations.set(parsed.generation, gen);
      byFamilyStorage.set(key, fam);
    }

    const findings: Finding[] = [];
    let order = 1;
    for (const fam of byFamilyStorage.values()) {
      if (fam.generations.size < 2) continue;
      const gens = [...fam.generations.entries()];
      const famLabel = `${fam.family.toUpperCase()} (${fam.storage.toUpperCase()})`;
      const evidence: EvidenceRow[] = gens.flatMap(([gen, b]) =>
        b.rows.slice(0, 5).map((r) => ({
          resourceId: r.resourceId,
          meter: r.meter,
          cost: round2(r.cost),
          reason: `Reservation on ${famLabel} ${gen || "(no gen)"} — fragments crawl across the family.`,
        }))
      );
      const totalCost = round2(gens.reduce((s, [, b]) => s + b.cost, 0));
      const genList = gens.map(([g]) => g || "(none)").join(", ");
      findings.push({
        id: `reservationGenerationConsolidation:${fam.family}:${fam.storage}`,
        category: "lever",
        jeannieRule: 4,
        order: order++,
        title: `Mixed-generation reservations on ${famLabel} family (${gens.length} generations)`,
        severity: "investigate",
        monthlySaving: null,
        annualSaving: null,
        currency: invoice.displayCurrency,
        confidence: "medium",
        evidence,
        narrative: {
          customer:
            `Your ${fam.storage.toUpperCase()} reservations for the ${fam.family.toUpperCase()} family span ${gens.length} ` +
            `different generations (${genList}). Reservations only crawl within a single generation, so this fragments ` +
            `your coverage. Consolidating to a single newer generation (typically v5) gives one pool that covers the ` +
            `whole ${fam.storage.toUpperCase()} side of the family.`,
          consultant:
            `${famLabel} reservations spread across ${genList}. Total spend: ${formatMoney(totalCost, invoice.displayCurrency)}. ` +
            `Per Jeannie Rule 4, mixed generations don't crawl across each other. Consolidation stays inside the ` +
            `${fam.storage.toUpperCase()} namespace (Instance Size Flexibility cannot bridge SSD↔HDD); target v5 (or newest ` +
            `stable) via Reservation Exchange — Jeannie Rule 5: every dollar transfers across exchanges, no penalty.`,
          informational:
            `Implements Jeannie Rule 4 (generation arm). Detection: same VM family + storage variant appears with ≥2 ` +
            `distinct generations in reservation meters. Buckets are split on the 's' suffix (premium SSD) because RIs ` +
            `cannot apply across the SSD/HDD boundary. Saving is not quantified — depends on per-VM utilisation profile.`,
        },
        discoveryQuestions: [
          `Is the v5 (or newest stable) ${fam.storage.toUpperCase()} generation a viable target for this family in your regions?`,
          `Are any workloads pinned to a specific older generation for compliance / driver reasons?`,
        ],
        effort: "medium",
        requiresConfirmation: ["Confirm exchange windows and any pinning constraints"],
      });
    }
    return findings.length > 0 ? findings : null;
  },
};
