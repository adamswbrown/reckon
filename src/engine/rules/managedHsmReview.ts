/**
 * Rule: Managed HSM review — flag for downgrade.
 * Implements Jeannie Rule 9 (humanity layer — discovery questions mandatory)
 * and Rule 10 (severity stays `conditional` — Managed HSM is sometimes a
 * compliance hard-requirement we cannot override from billing alone).
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney, nameFromResourceId } from "./_helpers";

export const managedHsmReviewRule: Rule = {
  id: "managedHsmReview",
  name: "Managed HSM downgrade review",
  framework: { rule: 9, quote: "Confirmed action requires the compliance question — never blind." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const rows = invoice.rows.filter(
      (r) => /\/managedhsms\//i.test(r.resourceId) && r.cost > 0
    );
    if (rows.length === 0) return null;

    const byVault = new Map<string, { cost: number; rows: typeof rows }>();
    for (const r of rows) {
      const id = r.resourceId.split(/managedhsms\//i)[1]?.split("/")[0] ?? r.resourceId;
      const v = byVault.get(id) ?? { cost: 0, rows: [] };
      v.cost += r.cost;
      v.rows.push(r);
      byVault.set(id, v);
    }

    const findings: Finding[] = [];
    let order = 1;
    for (const [name, v] of byVault) {
      const evidence: EvidenceRow[] = v.rows.map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: "Managed HSM instance — premium HSM-backed vault.",
      }));
      findings.push({
        id: `managedHsmReview:${name}`,
        category: "anomaly",
        jeannieRule: 9,
        order: order++,
        title: `Managed HSM review — ${name} (${formatMoney(round2(v.cost), invoice.displayCurrency)}/period)`,
        severity: "conditional",
        monthlySaving: round2(v.cost),
        annualSaving: round2(v.cost * 12),
        currency: invoice.displayCurrency,
        confidence: "low",
        evidence,
        narrative: {
          customer:
            `'${name}' is a Managed HSM — Azure's most secure key store. It costs ` +
            `${formatMoney(round2(v.cost), invoice.displayCurrency)} a month. If you don't have a ` +
            `compliance requirement that demands HSM-backed keys, a standard Key Vault would do the same job ` +
            `for a tiny fraction of the cost.`,
          consultant:
            `Managed HSM '${name}', ${formatMoney(round2(v.cost), invoice.displayCurrency)} period cost. ` +
            `Downgrade to Standard Key Vault is a few-day exercise (key migration). Validate first whether ` +
            `the workload needs FIPS 140-2 Level 3 attested hardware.`,
          informational:
            `Detection: resourceId matches '/managedhsms/'. Saving is the entire HSM line — net of any ` +
            `Key Vault Premium fee (~$1/key/month). Severity 'conditional' on the compliance question.`,
        },
        discoveryQuestions: [
          `Does any workload using '${name}' have a contractual / regulatory requirement for FIPS 140-2 Level 3 keys?`,
          `Are the keys in '${name}' BYOK or generated in-vault? (BYOK migration is straightforward; in-vault regenerated keys need rotation planning.)`,
        ],
        effort: "high",
        requiresConfirmation: [
          "Compliance / security sign-off on Standard tier",
          "Key migration plan",
        ],
      });
    }
    return findings;
  },
};
