/**
 * Rule: Cosmos DB provisioned throughput in non-prod RGs — recommend serverless.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney, isNonProdName, nameFromResourceId } from "./_helpers";

export const cosmosProvisionedNonProdRule: Rule = {
  id: "cosmosProvisionedNonProd",
  name: "Cosmos DB provisioned RU in non-prod → serverless",
  framework: { rule: 6, quote: "Always-on provisioned RU in non-prod is sprawl." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const rows = invoice.rows.filter(
      (r) =>
        r.serviceName === "Azure Cosmos DB" &&
        /\b\d+\s*ru\/s\b/i.test(r.meter)
    );
    if (rows.length === 0) return null;

    type C = { id: string; rg: string; cost: number; rows: typeof rows };
    const byAcct = new Map<string, C>();
    for (const r of rows) {
      if (!isNonProdName(`${r.resourceId} ${r.resourceGroupName}`)) continue;
      const id = nameFromResourceId(r.resourceId.split("/databaseAccounts/")[1]?.split("/")[0] ?? r.resourceId);
      const c = byAcct.get(id) ?? { id, rg: r.resourceGroupName, cost: 0, rows: [] };
      c.cost += r.cost;
      c.rows.push(r);
      byAcct.set(id, c);
    }
    if (byAcct.size === 0) return null;

    const findings: Finding[] = [];
    let order = 1;
    for (const c of byAcct.values()) {
      const monthly = round2(c.cost);
      if (monthly < 5) continue;
      const low = round2(monthly * 0.60);
      const high = round2(monthly * 0.80);
      const evidence: EvidenceRow[] = c.rows.slice(0, 10).map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `Provisioned RU/s on Cosmos account '${c.id}' in non-prod-named RG '${c.rg}'.`,
      }));
      findings.push({
        id: `cosmosProvisionedNonProd:${c.id}`,
        category: "anomaly",
        jeannieRule: 6,
        order: order++,
        title: `Cosmos DB serverless candidate — ${c.id} (${formatMoney(monthly, invoice.displayCurrency)}/period)`,
        severity: "conditional",
        monthlySaving: null,
        annualSaving: null,
        monthlySavingRange: [low, high],
        annualSavingRange: [round2(low * 12), round2(high * 12)],
        currency: invoice.displayCurrency,
        confidence: "medium",
        evidence,
        narrative: {
          customer:
            `Cosmos DB account '${c.id}' is in a non-prod environment with provisioned throughput, costing ` +
            `${formatMoney(monthly, invoice.displayCurrency)}/month. Switching to serverless typically saves ` +
            `${formatMoney(low, invoice.displayCurrency)}–${formatMoney(high, invoice.displayCurrency)}/month ` +
            `because non-prod traffic is bursty.`,
          consultant:
            `Cosmos '${c.id}' provisioned in non-prod RG '${c.rg}'. Serverless caveats: 50GB container limit, ` +
            `5,000 RU/s burst ceiling. Migration is account-level (re-create), not in-place.`,
          informational:
            `Detection: Cosmos DB rows with 'NN RU/s' meter in non-prod RGs. Saving 70% is typical when ` +
            `traffic is spiky and idle most of the time. The migration cost is real — re-create + data import.`,
        },
        discoveryQuestions: [
          `What is the actual sustained RU/s on '${c.id}' (vs the provisioned ceiling)?`,
          `Are any containers on '${c.id}' over 50GB or likely to grow past it?`,
        ],
        effort: "high",
        requiresConfirmation: [
          "Sustained RU/s measurement",
          "Container size audit",
          "Application reconfig for new account endpoint",
        ],
      });
    }
    return findings;
  },
};
