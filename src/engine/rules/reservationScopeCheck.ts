/**
 * Rule: reservation scope / SSD-variant / generation crawl-failure check.
 * Implements Jeannie Rule 4 — "I am a D2 v2 East. I must find one. ... it
 * will crawl and crawl and crawl" (transcript 193–197).
 *
 * Detection
 * ---------
 * We surface the *symptom* a customer can see from billing: a VM
 * family+generation+storage-variant+region bucket where there is BOTH an
 * active reservation AND non-zero PAYG compute. The PAYG is overflow — a sign
 * the reservation isn't crawling onto everything it could.
 *
 * Buckets are split on storage variant because Instance Size Flexibility
 * cannot crawl across the SSD/HDD boundary: D2V2 (HDD) and D2sV2 (SSD) live
 * in separate reservation namespaces, even though they share the same family
 * and generation. Mixing them in the same bucket would produce false-positive
 * overflows (HDD PAYG charged against an SSD reservation, or vice versa).
 *
 * Common remaining causes (called out in the narrative so the customer knows
 * what to check, even though we can't prove which one applies from billing
 * alone):
 *   - Reservation scoped to a single RG when Shared scope would crawl across
 *     the subscription family.
 *   - Wrong SKU sub-variant (Linux vs Windows reservation).
 *   - Reservation count below fleet size.
 *
 * Severity
 * --------
 * `investigate` — we cannot prove the cause from cost alone (Jeannie Rule 10).
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";
import { parseSkuToken, storageVariantLabel } from "../rates";
import { round2, formatMoney } from "./_helpers";
import { getFrameworkRule } from "../framework";

function isReservationRow(r: InvoiceRow): boolean {
  return /reservation/i.test(r.meter) || /reservation/i.test(r.serviceName);
}

export const reservationScopeCheckRule: Rule = {
  id: "reservationScopeCheck",
  name: "Reservation scope / variant crawl-failure check",
  framework: { rule: 4, quote: getFrameworkRule(4).statement },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    // Index PAYG VM rows and reservation rows by (family, generation, storage,
    // region). Storage is included because Instance Size Flexibility cannot
    // crawl across the SSD/HDD boundary — D2 v3 (HDD) and D2s v3 (SSD) live in
    // separate reservation namespaces even though they share family + gen.
    type Bucket = {
      paygCost: number;
      paygRows: InvoiceRow[];
      hasReservation: boolean;
      reservationRows: InvoiceRow[];
      family: string;
      generation: string;
      storage: "ssd" | "hdd";
      region: string;
    };
    const buckets = new Map<string, Bucket>();

    for (const r of invoice.rows) {
      if (r.serviceName !== "Virtual Machines") continue;
      const parsed = parseSkuToken(r.meter);
      const storage = storageVariantLabel(parsed);
      const region = r.resourceLocation || "(unspecified)";
      const key = `${parsed.family}_${parsed.generation}|${storage}|${region}`;
      const b = buckets.get(key) ?? {
        paygCost: 0,
        paygRows: [],
        hasReservation: false,
        reservationRows: [],
        family: parsed.family,
        generation: parsed.generation,
        storage,
        region,
      };
      if (isReservationRow(r)) {
        b.hasReservation = true;
        b.reservationRows.push(r);
      } else {
        b.paygCost += r.cost;
        b.paygRows.push(r);
      }
      buckets.set(key, b);
    }

    const overflow = [...buckets.values()].filter(
      (b) => b.hasReservation && b.paygCost > 0
    );
    if (overflow.length === 0) return null;

    const findings: Finding[] = [];
    let order = 1;
    for (const b of overflow) {
      const famLabel = `${b.family.toUpperCase()}${b.generation ? ` ${b.generation}` : ""} (${b.storage.toUpperCase()})`;
      const evidence: EvidenceRow[] = b.paygRows.slice(0, 25).map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `PAYG compute on family ${famLabel} despite reservation present in ${b.region}.`,
      }));
      const monthly = round2(b.paygCost);
      findings.push({
        id: `reservationScopeCheck:${b.family}_${b.generation}:${b.storage}:${b.region}`,
        category: "lever",
        jeannieRule: 4,
        order: order++,
        title: `Reservation overflow — family ${famLabel} in ${b.region} (${b.paygRows.length} VMs, ${formatMoney(monthly, invoice.displayCurrency)} PAYG)`,
        severity: "investigate",
        monthlySaving: null,
        annualSaving: null,
        currency: invoice.displayCurrency,
        confidence: "medium",
        evidence,
        narrative: {
          customer:
            `You hold a ${b.storage.toUpperCase()} reservation for the ${famLabel} family in ${b.region}, but ` +
            `${b.paygRows.length} servers in that same storage variant are still being charged at the full pay-as-you-go rate ` +
            `(${formatMoney(monthly, invoice.displayCurrency)} this period). The reservation is likely scoped to one resource group ` +
            `when it could be shared across the subscription, or the count is too low for the fleet.`,
          consultant:
            `Family/gen/storage/region bucket ${b.family}/${b.generation || "(no gen)"}/${b.storage}/${b.region}: ` +
            `reservation present, ${b.paygRows.length} PAYG VMs, ${formatMoney(monthly, invoice.displayCurrency)} overflow. ` +
            `Storage variant already matches (Instance Size Flexibility cannot crawl SSD↔HDD), so the remaining crawl-failure ` +
            `causes per Jeannie Rule 4 are (a) RG-scoped vs Shared scope and (b) reservation count below fleet size. ` +
            `Validate via Cost Management → Reservations → Utilisation, then resize or re-scope the reservation.`,
          informational:
            `Detection: same family+generation+storage+region has both reservation rows AND non-zero PAYG. ` +
            `Buckets are split on storage variant ('s' suffix = premium SSD) because RIs cannot apply across ` +
            `the SSD/HDD boundary. Cause unprovable from billing alone — severity stays 'investigate' (Jeannie Rule 10).`,
        },
        discoveryQuestions: [
          `Is the reservation for ${famLabel}/${b.region} scoped to a single RG, or Shared?`,
          `Is the reservation count short of the fleet size, or could the fleet shrink to fit?`,
          `If overflow persists, are any VMs reporting under a different SKU spelling that hides the storage variant?`,
        ],
        effort: "low",
        requiresConfirmation: ["Confirm reservation scope", "Confirm reservation count vs fleet size"],
      });
    }
    return findings;
  },
};
