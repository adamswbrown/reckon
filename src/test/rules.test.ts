/**
 * Per-rule framework-enforcement tests.
 *
 * Each rule is exercised with a minimal hand-rolled invoice fixture and
 * checked against:
 *   - emission: produces findings when the input pattern is present
 *   - silence: returns null when the input pattern is absent
 *   - framework lineage: every finding declares a valid jeannieRule (1..10)
 *   - validator: the produced findings pass validateFindings cleanly
 *
 * Rules with their own invariants (e.g. SQL HB must be a range) get an
 * explicit assertion on top of the generic ones.
 */

import { describe, it, expect } from "vitest";
import type { InvoiceRow, ParsedInvoice, Finding, Rule } from "../types";
import { validateFindings } from "../engine/validate";
import { isFrameworkRule } from "../engine/framework";

import { windowsHybridBenefitRule } from "../engine/rules/windowsHybridBenefit";
import { sqlHybridBenefitRule } from "../engine/rules/sqlHybridBenefit";
import { reservationScopeCheckRule } from "../engine/rules/reservationScopeCheck";
import { reservationGenerationConsolidationRule } from "../engine/rules/reservationGenerationConsolidation";
import { reservationStorageStandardisationRule } from "../engine/rules/reservationStorageStandardisation";
import { appServiceSavingsPlanRule } from "../engine/rules/appServiceSavingsPlan";
import { vmRuntimeDerivationRule } from "../engine/rules/vmRuntimeDerivation";
import { dormantVmClusterRule } from "../engine/rules/dormantVmCluster";
import { avdPoolUtilisationRule } from "../engine/rules/avdPoolUtilisation";
import { partTimeVmAnomalyRule } from "../engine/rules/partTimeVmAnomaly";
import { managedHsmReviewRule } from "../engine/rules/managedHsmReview";
import { sqlDatabaseLegacyRule } from "../engine/rules/sqlDatabaseLegacy";
import { privateEndpointSprawlRule } from "../engine/rules/privateEndpointSprawl";
import { fabricCapacityPauseRule } from "../engine/rules/fabricCapacityPause";
import { diskOversizingRule } from "../engine/rules/diskOversizing";
import { serviceBusNonProdPremiumRule } from "../engine/rules/serviceBusNonProdPremium";
import { appGatewayPerEnvRule } from "../engine/rules/appGatewayPerEnv";
import { sqlMiContinuousRule } from "../engine/rules/sqlMiContinuous";
import { entraDsCoexistenceRule } from "../engine/rules/entraDsCoexistence";
import { bastionStandardNonProdRule } from "../engine/rules/bastionStandardNonProd";
import { cogSearchDuplicateRule } from "../engine/rules/cogSearchDuplicate";
import { cosmosProvisionedNonProdRule } from "../engine/rules/cosmosProvisionedNonProd";
import { vpnGatewayAzReviewRule } from "../engine/rules/vpnGatewayAzReview";

/* ---------------------------------------------------------------------- */
/* Fixture builders                                                       */
/* ---------------------------------------------------------------------- */

function row(overrides: Partial<InvoiceRow>): InvoiceRow {
  return {
    resourceId: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm",
    resourceType: "microsoft.compute/virtualmachines",
    resourceLocation: "eastus",
    resourceGroupName: "rg",
    subscriptionName: "sub",
    serviceName: "Virtual Machines",
    meter: "D8s v5",
    tags: "",
    costUsd: 0,
    cost: 0,
    currency: "USD",
    ...overrides,
  };
}

function invoice(rows: InvoiceRow[], overrides: Partial<ParsedInvoice> = {}): ParsedInvoice {
  return {
    customerName: "Fixture",
    period: { startDate: "2026-01-01", endDate: "2026-01-31", hoursInPeriod: 744 },
    displayCurrency: "USD",
    rows,
    totalCost: { amount: rows.reduce((s, r) => s + r.cost, 0), currency: "USD" },
    totalCostUsd: { amount: rows.reduce((s, r) => s + r.costUsd, 0), currency: "USD" },
    sourceFile: "fixture.xlsx",
    ...overrides,
  };
}

/** Run a rule and normalise its output to an array (dropping null). */
function run(rule: Rule, inv: ParsedInvoice): Finding[] {
  const out = rule.evaluate(inv);
  if (!out) return [];
  return Array.isArray(out) ? out : [out];
}

/** Generic invariants every rule must satisfy on every emitted finding. */
function assertGenericInvariants(findings: Finding[], inv: ParsedInvoice): void {
  for (const f of findings) {
    expect(isFrameworkRule(f.jeannieRule)).toBe(true);
    expect(f.title.length).toBeGreaterThan(0);
    expect(f.narrative.customer.length).toBeGreaterThan(0);
    expect(f.narrative.consultant.length).toBeGreaterThan(0);
    expect(f.narrative.informational.length).toBeGreaterThan(0);
  }
  // Validator is the ultimate gate — if a rule emits dirty findings, this
  // catches it. Test fails on any error-level issue.
  const report = validateFindings(findings, inv);
  const errors = report.issues.filter((i) => i.level === "error");
  if (errors.length > 0) {
    throw new Error(
      `Rule produced findings that fail validation:\n${errors.map((e) => `  - ${e.code}: ${e.message}`).join("\n")}`
    );
  }
}

/* ====================================================================== */
/* LEVERS                                                                 */
/* ====================================================================== */

describe("rule: windowsHybridBenefit", () => {
  it("returns null when no Windows licence rows", () => {
    expect(windowsHybridBenefitRule.evaluate(invoice([]))).toBeNull();
  });
  it("excludes SQL-flavoured licence rows from Layer 1", () => {
    const rows = [
      row({ serviceName: "Virtual Machines Licenses", meter: "SQL Standard 4 Cores", cost: 100, costUsd: 100 }),
    ];
    const findings = run(windowsHybridBenefitRule, invoice(rows));
    // Either no findings or a small-VM tail finding — the SQL row must NOT
    // appear under windowsHybridBenefit.
    for (const f of findings) {
      const hasSqlEvidence = f.evidence.some((e) => /sql/i.test(e.meter));
      expect(hasSqlEvidence).toBe(false);
    }
  });
});

describe("rule: sqlHybridBenefit (Layer 2)", () => {
  it("emits a range, never a point estimate (Rule 2)", () => {
    const rows = [
      row({
        resourceId: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/sqlvm-prod",
        meter: "D8s v5",
        cost: 500,
        costUsd: 500,
      }),
    ];
    const findings = run(sqlHybridBenefitRule, invoice(rows));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.monthlySaving).toBeNull();
      expect(f.monthlySavingRange).toBeDefined();
      expect(f.monthlySavingRange![0]).toBeLessThan(f.monthlySavingRange![1]);
    }
    assertGenericInvariants(findings, invoice(rows));
  });
  it("ignores VMs without SQL hint", () => {
    const rows = [row({ resourceId: "/.../webserver-01", meter: "D8s v5", cost: 500, costUsd: 500 })];
    expect(sqlHybridBenefitRule.evaluate(invoice(rows))).toBeNull();
  });
});

describe("rule: reservationScopeCheck", () => {
  it("flags overflow when reservation + PAYG coexist on same family/region", () => {
    const rows = [
      row({ meter: "D4s v5 Reservation", cost: 100, costUsd: 100, resourceId: "/.../res" }),
      row({ meter: "D4s v5", cost: 50, costUsd: 50, resourceId: "/.../vm-overflow" }),
    ];
    const findings = run(reservationScopeCheckRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("investigate"); // Rule 10 — cause unprovable
    assertGenericInvariants(findings, invoice(rows));
  });
  it("returns null when only reservation rows exist", () => {
    const rows = [row({ meter: "D4s v5 Reservation", cost: 100, costUsd: 100 })];
    expect(reservationScopeCheckRule.evaluate(invoice(rows))).toBeNull();
  });
  it("does NOT flag overflow when SSD reservation coexists with HDD PAYG (separate RI namespaces)", () => {
    // D4s v5 (SSD) reservation + D4 v3 (HDD) PAYG: same letter family but
    // Instance Size Flexibility cannot crawl across SSD/HDD, so this is not
    // overflow — they live in different reservation namespaces.
    const rows = [
      row({ meter: "D4s v5 Reservation", cost: 100, costUsd: 100, resourceId: "/.../ssd-res" }),
      row({ meter: "D4 v3", cost: 50, costUsd: 50, resourceId: "/.../hdd-vm" }),
    ];
    expect(reservationScopeCheckRule.evaluate(invoice(rows))).toBeNull();
  });
  it("flags overflow within the SSD bucket while ignoring an unrelated HDD PAYG row", () => {
    const rows = [
      row({ meter: "D4s v5 Reservation", cost: 100, costUsd: 100, resourceId: "/.../ssd-res" }),
      row({ meter: "D2s v5", cost: 25, costUsd: 25, resourceId: "/.../ssd-overflow" }),
      row({ meter: "D4 v3", cost: 50, costUsd: 50, resourceId: "/.../hdd-noise" }),
    ];
    const findings = run(reservationScopeCheckRule, invoice(rows));
    expect(findings.length).toBe(1);
    // Evidence should only contain the SSD overflow VM, not the HDD one.
    expect(findings[0].evidence.length).toBe(1);
    expect(findings[0].evidence[0].resourceId).toBe("/.../ssd-overflow");
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: reservationGenerationConsolidation", () => {
  it("flags when ≥2 generations on the same family", () => {
    const rows = [
      row({ meter: "D4s v3 Reservation", cost: 100, costUsd: 100, resourceId: "/.../r1" }),
      row({ meter: "D4s v5 Reservation", cost: 100, costUsd: 100, resourceId: "/.../r2" }),
    ];
    const findings = run(reservationGenerationConsolidationRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("investigate");
    assertGenericInvariants(findings, invoice(rows));
  });
  it("silent on a single generation", () => {
    const rows = [row({ meter: "D4s v5 Reservation", cost: 100, costUsd: 100 })];
    expect(reservationGenerationConsolidationRule.evaluate(invoice(rows))).toBeNull();
  });
  it("does NOT flag when generations differ but storage variant differs too", () => {
    // D4 v3 (HDD) + D4s v5 (SSD): different generations, but they're in
    // separate RI namespaces, so consolidation isn't an option — silent.
    const rows = [
      row({ meter: "D4 v3 Reservation", cost: 100, costUsd: 100, resourceId: "/.../hdd-r" }),
      row({ meter: "D4s v5 Reservation", cost: 100, costUsd: 100, resourceId: "/.../ssd-r" }),
    ];
    expect(reservationGenerationConsolidationRule.evaluate(invoice(rows))).toBeNull();
  });
  it("flags only the SSD bucket when SSD has multi-gen and HDD has single-gen", () => {
    const rows = [
      row({ meter: "D4s v4 Reservation", cost: 100, costUsd: 100, resourceId: "/.../ssd-v4" }),
      row({ meter: "D4s v5 Reservation", cost: 100, costUsd: 100, resourceId: "/.../ssd-v5" }),
      row({ meter: "D4 v3 Reservation",  cost: 100, costUsd: 100, resourceId: "/.../hdd-v3" }),
    ];
    const findings = run(reservationGenerationConsolidationRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].id).toContain("ssd");
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: reservationStorageStandardisation", () => {
  it("flags when the same family runs on both SSD and HDD in one region", () => {
    const rows = [
      row({ meter: "D4s v5", cost: 100, costUsd: 100, resourceId: "/.../ssd-vm" }),
      row({ meter: "D4 v3",  cost: 50,  costUsd: 50,  resourceId: "/.../hdd-vm" }),
    ];
    const findings = run(reservationStorageStandardisationRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("investigate");
    expect(findings[0].narrative.consultant).toMatch(/Instance Size Flexibility/);
    expect(findings[0].narrative.consultant).toMatch(/standing remediation/i);
    // Evidence should include both sides.
    expect(findings[0].evidence.some((e) => e.resourceId === "/.../ssd-vm")).toBe(true);
    expect(findings[0].evidence.some((e) => e.resourceId === "/.../hdd-vm")).toBe(true);
    assertGenericInvariants(findings, invoice(rows));
  });
  it("fires independently of any reservation row — pure split-storage signal is enough", () => {
    // No 'Reservation' meters at all; split storage alone should trigger.
    const rows = [
      row({ meter: "D2s v5", cost: 30, costUsd: 30, resourceId: "/.../ssd-only-1" }),
      row({ meter: "D2 v3",  cost: 30, costUsd: 30, resourceId: "/.../hdd-only-1" }),
    ];
    const findings = run(reservationStorageStandardisationRule, invoice(rows));
    expect(findings.length).toBe(1);
    assertGenericInvariants(findings, invoice(rows));
  });
  it("silent when family is single-storage (SSD only)", () => {
    const rows = [
      row({ meter: "D2s v5", cost: 30, costUsd: 30, resourceId: "/.../ssd-1" }),
      row({ meter: "D4s v5", cost: 60, costUsd: 60, resourceId: "/.../ssd-2" }),
    ];
    expect(reservationStorageStandardisationRule.evaluate(invoice(rows))).toBeNull();
  });
  it("does NOT cross regions — same family on different sides in different regions is two separate stories", () => {
    const rows = [
      row({ meter: "D4s v5", resourceLocation: "eastus",     cost: 100, costUsd: 100, resourceId: "/.../east-ssd" }),
      row({ meter: "D4 v3",  resourceLocation: "westeurope", cost: 50,  costUsd: 50,  resourceId: "/.../weu-hdd" }),
    ];
    expect(reservationStorageStandardisationRule.evaluate(invoice(rows))).toBeNull();
  });
});

describe("rule: appServiceSavingsPlan", () => {
  it("produces a range finding (Jeannie Rule 5 — exchange-safe)", () => {
    const rows = [
      row({
        serviceName: "Azure App Service",
        resourceType: "microsoft.web/serverfarms",
        resourceId: "/subscriptions/x/rg/providers/Microsoft.Web/serverfarms/asp-prod",
        meter: "P2 v3 App",
        cost: 500,
        costUsd: 500,
      }),
    ];
    const findings = run(appServiceSavingsPlanRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].monthlySavingRange).toBeDefined();
    assertGenericInvariants(findings, invoice(rows));
  });
  it("excludes F-tier free apps from eligible spend", () => {
    const rows = [
      row({
        serviceName: "Azure App Service",
        resourceId: "/subscriptions/x/rg/providers/Microsoft.Web/serverfarms/asp-free",
        meter: "F1 App",
        cost: 0,
        costUsd: 0,
      }),
    ];
    expect(appServiceSavingsPlanRule.evaluate(invoice(rows))).toBeNull();
  });
});

/* ====================================================================== */
/* RUNTIME                                                                */
/* ====================================================================== */

describe("rule: vmRuntimeDerivation", () => {
  it("classifies an unreserved-running VM and computes hours", () => {
    const rows = [
      row({ meter: "D4s v5", cost: 50, costUsd: 50, resourceId: "/.../vm-x" }),
    ];
    const findings = run(vmRuntimeDerivationRule, invoice(rows));
    const unreserved = findings.find((f) => f.id.includes("unreserved-running"));
    expect(unreserved).toBeDefined();
    expect(unreserved!.severity).toBe("investigate"); // facts, not savings (Rule 10)
    expect(unreserved!.evidence[0].reason).toMatch(/billed at|0\.192/);
    assertGenericInvariants(findings, invoice(rows));
  });
  it("classifies a $0-compute VM with no reservation as apparently-dormant", () => {
    const rows = [
      row({ meter: "D4s v5", cost: 0, costUsd: 0, resourceId: "/.../vm-off" }),
    ];
    const findings = run(vmRuntimeDerivationRule, invoice(rows));
    const dormant = findings.find((f) => f.id.includes("apparently-dormant"));
    expect(dormant).toBeDefined();
  });
});

describe("rule: dormantVmCluster", () => {
  it("clusters dormant VMs by RG and quantifies ambient cost", () => {
    const rows: InvoiceRow[] = [
      row({ resourceId: "/.../vm-off-1", cost: 0, costUsd: 0, resourceGroupName: "rg-stale" }),
      row({
        resourceId: "/.../disk-1",
        resourceType: "microsoft.compute/disks",
        serviceName: "Storage",
        meter: "P30 LRS Disk",
        resourceGroupName: "rg-stale",
        cost: 50,
        costUsd: 50,
      }),
    ];
    const findings = run(dormantVmClusterRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("investigate"); // Rule 10
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: avdPoolUtilisation", () => {
  it("emits an observation when AVD-named VMs are present", () => {
    const rows = [
      row({
        resourceId: "/subscriptions/x/resourceGroups/avd-pool-rg/providers/Microsoft.Compute/virtualMachines/sessionhost-1",
        resourceGroupName: "avd-pool-rg",
        meter: "D4s v5",
        cost: 100,
        costUsd: 100,
      }),
    ];
    const findings = run(avdPoolUtilisationRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("investigate");
    expect(findings[0].monthlySaving).toBeNull(); // Rule 6 — pool low-util is healthy
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: partTimeVmAnomaly", () => {
  it("flags a VM running ~25% of the period", () => {
    // D4s v5 eastus = $0.192/hr → 25% of 744h × 0.192 ≈ $35.71
    const rows = [
      row({ resourceId: "/.../vm-parttime", meter: "D4s v5", cost: 35.71, costUsd: 35.71 }),
    ];
    const findings = run(partTimeVmAnomalyRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("investigate");
    assertGenericInvariants(findings, invoice(rows));
  });
  it("ignores always-on VMs (Jeannie Rule 6 — sprawl is expected)", () => {
    const rows = [
      row({ meter: "D4s v5", cost: 0.192 * 744, costUsd: 0.192 * 744 }),
    ];
    expect(partTimeVmAnomalyRule.evaluate(invoice(rows))).toBeNull();
  });
});

/* ====================================================================== */
/* ANOMALIES                                                              */
/* ====================================================================== */

describe("rule: managedHsmReview", () => {
  it("emits when a managedHSM resource is present", () => {
    const rows = [
      row({
        resourceId: "/subscriptions/x/resourceGroups/sec/providers/Microsoft.KeyVault/managedHSMs/secrets-hsm",
        resourceType: "microsoft.keyvault/managedhsms",
        serviceName: "Key Vault",
        meter: "Standard B1 Instance",
        cost: 3000,
        costUsd: 3000,
      }),
    ];
    const findings = run(managedHsmReviewRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].discoveryQuestions.length).toBeGreaterThan(0); // Rule 9
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: sqlDatabaseLegacy", () => {
  it("emits a confirmed delete candidate for a `_old` SQL DB", () => {
    const rows = [
      row({
        resourceId: "/.../servers/srv1/databases/customer_old",
        resourceType: "microsoft.sql/servers",
        serviceName: "SQL Database",
        meter: "vCore",
        cost: 200,
        costUsd: 200,
      }),
    ];
    const findings = run(sqlDatabaseLegacyRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("confirmed"); // Rule 10 — aggregable
    expect(findings[0].discoveryQuestions.length).toBeGreaterThan(0); // Rule 9 — still mandatory because effort=medium
    assertGenericInvariants(findings, invoice(rows));
  });
  it("ignores actively-named DBs", () => {
    const rows = [
      row({
        resourceId: "/.../servers/srv1/databases/customer_prod",
        serviceName: "SQL Database",
        cost: 200,
        costUsd: 200,
      }),
    ];
    expect(sqlDatabaseLegacyRule.evaluate(invoice(rows))).toBeNull();
  });
});

describe("rule: privateEndpointSprawl", () => {
  it("flags only non-prod RGs", () => {
    const rows = [
      row({
        serviceName: "Virtual Network",
        meter: "Standard Private Endpoint",
        resourceGroupName: "apinet-dev-rg",
        resourceId: "/.../pe-1",
        cost: 50,
        costUsd: 50,
      }),
      row({
        serviceName: "Virtual Network",
        meter: "Standard Private Endpoint",
        resourceGroupName: "apinet-prod-rg",
        resourceId: "/.../pe-2",
        cost: 50,
        costUsd: 50,
      }),
    ];
    const findings = run(privateEndpointSprawlRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].id).toContain("dev");
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: fabricCapacityPause", () => {
  it("emits a range finding for a Fabric capacity (Rule 9 — discovery question on batch jobs)", () => {
    const rows = [
      row({
        serviceName: "Microsoft Fabric",
        resourceType: "microsoft.fabric/capacities",
        resourceId: "/.../capacities/fcap-prod",
        meter: "OneLake Read Operations Hot Capacity Usage CU",
        cost: 1000,
        costUsd: 1000,
      }),
    ];
    const findings = run(fabricCapacityPauseRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].monthlySavingRange).toBeDefined();
    expect(findings[0].discoveryQuestions.some((q) => /batch|schedule/i.test(q))).toBe(true);
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: diskOversizing", () => {
  it("emits a range finding for P40 disks in AVD RGs", () => {
    const rows = [
      row({
        resourceType: "microsoft.compute/disks",
        serviceName: "Storage",
        meter: "P40 LRS Disk",
        resourceGroupName: "avd-pool-rg",
        resourceId: "/.../disks/disk-big",
        cost: 200,
        costUsd: 200,
      }),
    ];
    const findings = run(diskOversizingRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].monthlySavingRange).toBeDefined(); // Rule 7 — must be range
    assertGenericInvariants(findings, invoice(rows));
  });
  it("ignores P40 disks NOT in AVD RGs (could be SQL)", () => {
    const rows = [
      row({
        resourceType: "microsoft.compute/disks",
        meter: "P40 LRS Disk",
        resourceGroupName: "sqlserver-prod-rg",
        cost: 200,
        costUsd: 200,
      }),
    ];
    expect(diskOversizingRule.evaluate(invoice(rows))).toBeNull();
  });
});

describe("rule: serviceBusNonProdPremium", () => {
  it("emits a range finding for premium SB in non-prod RG", () => {
    const rows = [
      row({
        serviceName: "Service Bus",
        resourceType: "microsoft.servicebus/namespaces",
        resourceId: "/subscriptions/x/resourceGroups/msg-test-rg/providers/Microsoft.ServiceBus/namespaces/msg-test-sbns",
        resourceGroupName: "msg-test-rg",
        meter: "Premium Messaging Unit",
        cost: 600,
        costUsd: 600,
      }),
    ];
    const findings = run(serviceBusNonProdPremiumRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].monthlySavingRange).toBeDefined();
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: appGatewayPerEnv", () => {
  it("emits when >5 distinct gateways exist", () => {
    const rows: InvoiceRow[] = Array.from({ length: 6 }, (_, i) =>
      row({
        serviceName: "Application Gateway",
        resourceType: "microsoft.network/applicationgateways",
        resourceId: `/subscriptions/x/rg/providers/Microsoft.Network/applicationGateways/agw-${i}`,
        meter: "Standard Capacity Units",
        cost: 100,
        costUsd: 100,
      })
    );
    const findings = run(appGatewayPerEnvRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].monthlySavingRange).toBeDefined();
    assertGenericInvariants(findings, invoice(rows));
  });
  it("silent on ≤5 gateways", () => {
    const rows: InvoiceRow[] = Array.from({ length: 3 }, (_, i) =>
      row({
        serviceName: "Application Gateway",
        resourceType: "microsoft.network/applicationgateways",
        resourceId: `/.../agw-${i}`,
        cost: 100,
        costUsd: 100,
      })
    );
    expect(appGatewayPerEnvRule.evaluate(invoice(rows))).toBeNull();
  });
});

describe("rule: sqlMiContinuous", () => {
  it("emits a range finding for non-prod MI", () => {
    const rows = [
      row({
        resourceType: "microsoft.sql/managedinstances",
        serviceName: "SQL Database",
        resourceId: "/subscriptions/x/resourceGroups/aspire-qa-rg/providers/Microsoft.Sql/managedInstances/aspire-qa-replica",
        resourceGroupName: "aspire-qa-rg",
        meter: "vCore",
        cost: 800,
        costUsd: 800,
      }),
    ];
    const findings = run(sqlMiContinuousRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].monthlySavingRange).toBeDefined();
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: entraDsCoexistence", () => {
  it("flags coexistence as investigate ONLY (Rule 10 — never recommends action on identity)", () => {
    const rows = [
      row({
        serviceName: "Microsoft Entra Domain Services",
        resourceType: "microsoft.aad/domainservices",
        resourceId: "/.../domainservices/eds-1",
        meter: "Premium User Forest",
        cost: 500,
        costUsd: 500,
      }),
      row({
        resourceId: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/dc01",
        meter: "D4s v5",
        cost: 200,
        costUsd: 200,
      }),
    ];
    const findings = run(entraDsCoexistenceRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("investigate");
    expect(findings[0].monthlySaving).toBeNull(); // never quantifies
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: bastionStandardNonProd", () => {
  it("emits a range finding (downgrade % is itself an estimate)", () => {
    const rows = [
      row({
        serviceName: "Azure Bastion",
        resourceType: "microsoft.network/bastionhosts",
        resourceId: "/subscriptions/x/resourceGroups/build-dev-rg/providers/Microsoft.Network/bastionHosts/build-dev-bastion",
        resourceGroupName: "build-dev-rg",
        meter: "Standard Gateway",
        cost: 220,
        costUsd: 220,
      }),
    ];
    const findings = run(bastionStandardNonProdRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].monthlySavingRange).toBeDefined();
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: cogSearchDuplicate", () => {
  it("flags non-prod Search instances when ≥2 instances exist", () => {
    const rows = [
      row({
        serviceName: "Azure Cognitive Search",
        resourceType: "microsoft.search/searchservices",
        resourceId: "/subscriptions/x/rg/providers/Microsoft.Search/searchServices/cog-prod",
        meter: "Standard S1 Unit",
        cost: 250,
        costUsd: 250,
      }),
      row({
        serviceName: "Azure Cognitive Search",
        resourceType: "microsoft.search/searchservices",
        resourceId: "/subscriptions/x/rg/providers/Microsoft.Search/searchServices/cog-dev",
        resourceGroupName: "search-dev-rg",
        meter: "Standard S1 Unit",
        cost: 250,
        costUsd: 250,
      }),
    ];
    const findings = run(cogSearchDuplicateRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].id).toContain("cog-dev");
    expect(findings[0].monthlySavingRange).toBeDefined();
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: cosmosProvisionedNonProd", () => {
  it("emits a range finding for provisioned RU in non-prod", () => {
    const rows = [
      row({
        serviceName: "Azure Cosmos DB",
        resourceType: "microsoft.documentdb/databaseaccounts",
        resourceId: "/subscriptions/x/resourceGroups/svc-sales-dev-rg/providers/Microsoft.DocumentDB/databaseAccounts/svc-sales-dev-cdb",
        resourceGroupName: "svc-sales-dev-rg",
        meter: "100 RU/s",
        cost: 120,
        costUsd: 120,
      }),
    ];
    const findings = run(cosmosProvisionedNonProdRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].monthlySavingRange).toBeDefined();
    assertGenericInvariants(findings, invoice(rows));
  });
});

describe("rule: vpnGatewayAzReview", () => {
  it("emits a range finding for AZ-tier gateways", () => {
    const rows = [
      row({
        serviceName: "VPN Gateway",
        resourceType: "microsoft.network/virtualnetworkgateways",
        resourceId: "/.../virtualNetworkGateways/avd_vpn_gateway",
        meter: "VpnGw2AZ",
        cost: 400,
        costUsd: 400,
      }),
    ];
    const findings = run(vpnGatewayAzReviewRule, invoice(rows));
    expect(findings.length).toBe(1);
    expect(findings[0].monthlySavingRange).toBeDefined();
    expect(findings[0].discoveryQuestions.some((q) => /SLA|production/i.test(q))).toBe(true);
    assertGenericInvariants(findings, invoice(rows));
  });
  it("silent for non-AZ gateways", () => {
    const rows = [row({ serviceName: "VPN Gateway", meter: "VpnGw2", cost: 200, costUsd: 200 })];
    expect(vpnGatewayAzReviewRule.evaluate(invoice(rows))).toBeNull();
  });
});
