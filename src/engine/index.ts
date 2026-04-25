/**
 * Engine orchestrator — single entry point used by the renderer and the
 * Electron preload. Adds rules in the order Jeannie's framework demands
 * (Hybrid Benefit → Reservations → Savings Plans, then Runtime, then
 * Anomalies). Display order in the report is then re-stamped per finding.
 *
 * To register a new rule:
 *   1. Implement it under `src/engine/rules/`.
 *   2. Import it here.
 *   3. Add it to ALL_RULES in the framework-order position.
 *   4. Add a framework-rule enforcement test in src/test/.
 */

import type {
  Finding,
  LandscapeCard,
  ParsedInvoice,
  Rule,
  ValidationReport,
} from "../types";
import { buildLandscape } from "./landscape";
import { validateFindings, sumMonthlySaving } from "./validate";

// LEVERS — Jeannie Rule 1 demands this exact order (HB → Reservations → Savings Plans).
import { windowsHybridBenefitRule } from "./rules/windowsHybridBenefit";
import { sqlHybridBenefitRule } from "./rules/sqlHybridBenefit";
import { reservationScopeCheckRule } from "./rules/reservationScopeCheck";
import { reservationGenerationConsolidationRule } from "./rules/reservationGenerationConsolidation";
import { reservationStorageStandardisationRule } from "./rules/reservationStorageStandardisation";
import { appServiceSavingsPlanRule } from "./rules/appServiceSavingsPlan";

// RUNTIME — Jeannie Rules 6, 8.
import { vmRuntimeDerivationRule } from "./rules/vmRuntimeDerivation";
import { dormantVmClusterRule } from "./rules/dormantVmCluster";
import { avdPoolUtilisationRule } from "./rules/avdPoolUtilisation";
import { partTimeVmAnomalyRule } from "./rules/partTimeVmAnomaly";

// ANOMALIES — Jeannie Rules 6, 7, 9, 10.
import { managedHsmReviewRule } from "./rules/managedHsmReview";
import { sqlDatabaseLegacyRule } from "./rules/sqlDatabaseLegacy";
import { privateEndpointSprawlRule } from "./rules/privateEndpointSprawl";
import { fabricCapacityPauseRule } from "./rules/fabricCapacityPause";
import { diskOversizingRule } from "./rules/diskOversizing";
import { serviceBusNonProdPremiumRule } from "./rules/serviceBusNonProdPremium";
import { appGatewayPerEnvRule } from "./rules/appGatewayPerEnv";
import { sqlMiContinuousRule } from "./rules/sqlMiContinuous";
import { entraDsCoexistenceRule } from "./rules/entraDsCoexistence";
import { bastionStandardNonProdRule } from "./rules/bastionStandardNonProd";
import { cogSearchDuplicateRule } from "./rules/cogSearchDuplicate";
import { cosmosProvisionedNonProdRule } from "./rules/cosmosProvisionedNonProd";
import { vpnGatewayAzReviewRule } from "./rules/vpnGatewayAzReview";

export const ALL_RULES: readonly Rule[] = [
  // Levers — first, in framework order
  windowsHybridBenefitRule,                  // J2/J3 — Layer 1 (visible)
  sqlHybridBenefitRule,                      // J2    — Layer 2 (invisible)
  reservationScopeCheckRule,                 // J4    — crawl scope/variant
  reservationGenerationConsolidationRule,    // J4/J5 — generation consolidation
  reservationStorageStandardisationRule,     // J4    — standardise on SSD for ISF
  appServiceSavingsPlanRule,                 // J1/J5 — Savings Plans third

  // Runtime — facts first, then dependent recommendations
  vmRuntimeDerivationRule,                   // J8    — hours-from-cost
  dormantVmClusterRule,                      // J6    — RG-level ambient cost
  avdPoolUtilisationRule,                    // J6    — pool ceiling observation
  partTimeVmAnomalyRule,                     // J8    — schedule check

  // Anomalies — confirmed deletions and sprawl
  managedHsmReviewRule,                      // J9
  sqlDatabaseLegacyRule,                     // J10   — confirmed deletions
  privateEndpointSprawlRule,                 // J6
  fabricCapacityPauseRule,                   // J9
  diskOversizingRule,                        // J7
  serviceBusNonProdPremiumRule,              // J9
  appGatewayPerEnvRule,                      // J6
  sqlMiContinuousRule,                       // J6
  entraDsCoexistenceRule,                    // J10   — investigate-only
  bastionStandardNonProdRule,                // J10   — confirmed downgrade
  cogSearchDuplicateRule,                    // J6
  cosmosProvisionedNonProdRule,              // J6
  vpnGatewayAzReviewRule,                    // J7
] as const;

export interface AnalysisResult {
  invoice: ParsedInvoice;
  findings: Finding[];
  /**
   * Descriptive context cards (top-N, Pareto, region, governance). Render
   * BEFORE findings to frame the conversation. Cards never carry savings
   * and never claim Jeannie-rule lineage — they're shape, not action.
   */
  landscape: LandscapeCard[];
  validation: ValidationReport;
  /**
   * Sum of confirmed + conditional-floor savings (excludes investigate
   * per Jeannie Rule 10). Use this for the "immediate wins" headline.
   */
  immediateWinsMonthly: number;
}

export function analyse(invoice: ParsedInvoice): AnalysisResult {
  const findings: Finding[] = [];
  for (const rule of ALL_RULES) {
    const out = rule.evaluate(invoice);
    if (!out) continue;
    if (Array.isArray(out)) findings.push(...out);
    else findings.push(out);
  }

  // Re-stamp display order across all findings, preserving rule-emission order
  // (which already respects Jeannie Rule 1).
  findings.forEach((f, i) => (f.order = i + 1));

  const validation = validateFindings(findings, invoice);
  return {
    invoice,
    findings,
    landscape: buildLandscape(invoice),
    validation,
    immediateWinsMonthly: sumMonthlySaving(findings),
  };
}
