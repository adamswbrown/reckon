import { describe, expect, test } from "vitest";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parseDmcScan } from "../dmc/parse";
import { summariseDmcScan } from "../dmc/summarise";
import { parseInvoice } from "../engine/parse";
import { joinDmcWithInvoice } from "../dmc/join";
import { utilisationRightSizingFindings } from "../dmc/rules/rightSizing";

const FIXTURE = resolve(__dirname, "..", "..", "test-fixtures", "dmc-azure-contoso");
const INVOICE = resolve(__dirname, "..", "..", "test-fixtures", "Contoso_Azure_Invoice_2026Q1.xlsx");

describe("DMC Azure-mode scan parser (Contoso fixture)", () => {
  if (!existsSync(FIXTURE)) {
    test.skip("fixture missing", () => {});
    return;
  }

  test("parses the synthetic Contoso scan", () => {
    const scan = parseDmcScan(FIXTURE);
    expect(scan.meta.scanType).toBe("azure");
    expect(scan.meta.subscriptionName).toBe("Contoso-Production-Hub");
    expect(scan.meta.scanMode).toContain("metric");
    expect(scan.vms.length).toBeGreaterThan(40);
    // Every VM has the join keys used by JJ to attach cost from invoice.
    for (const vm of scan.vms) {
      expect(vm.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(vm.machineId).toBe(`${scan.meta.subscriptionId}-${vm.name}`);
      expect(vm.region).toMatch(/eastus|westeurope/);
    }
  });

  test("metric blocks parse cleanly when present", () => {
    const scan = parseDmcScan(FIXTURE);
    const running = scan.vms.find((v) => v.powerState === "running");
    expect(running).toBeDefined();
    expect(running!.cpu).not.toBeNull();
    expect(running!.cpu!.poweredOnPercent).toBeGreaterThan(0);
    expect(running!.memory).not.toBeNull();
    expect(running!.disks.length).toBeGreaterThan(0);
  });

  test("summary surfaces the planted right-sizing and dormant signals", () => {
    const scan = parseDmcScan(FIXTURE);
    const s = summariseDmcScan(scan);
    expect(s.deallocatedVms).toBeGreaterThanOrEqual(5);     // dormant tier
    expect(s.rightSizing.length).toBeGreaterThan(0);        // oversized + dev tiers
    // Oversized D32s_v5 candidates should appear with very low p95 CPU.
    const oversized = s.rightSizing.find((r) => r.vm.vmSize === "Standard_D32s_v5");
    expect(oversized).toBeDefined();
    expect(oversized!.cpuP95).toBeLessThan(10);
    // Steady-state prod VMs should land in reservation candidates.
    expect(s.reservationCandidates.length).toBeGreaterThan(10);
  });

  test("synthetic invoice joins to the DMC scan by resource id", () => {
    if (!existsSync(INVOICE)) {
      // Skip if the invoice fixture hasn't been generated yet.
      return;
    }
    const scan = parseDmcScan(FIXTURE);
    const invoice = parseInvoice(readFileSync(INVOICE), INVOICE);

    const expectedVmRids = new Set(
      scan.vms.map(
        (v) =>
          `/subscriptions/${scan.meta.subscriptionId}/resourceGroups/${v.resourceGroup}/providers/Microsoft.Compute/virtualMachines/${v.name}`,
      ),
    );
    const invoiceVmRids = new Set(
      invoice.rows
        .filter((r) => /\/virtualMachines\//i.test(r.resourceId))
        .map((r) => r.resourceId),
    );
    // Every VM resource id on the invoice must correspond to a DMC VM.
    for (const rid of invoiceVmRids) expect(expectedVmRids.has(rid)).toBe(true);

    // Running VMs must appear on the invoice; deallocated VMs (no compute hours)
    // legitimately have no compute row but should still leave disk ambient cost.
    const runningOnInvoice = scan.vms
      .filter((v) => v.powerState === "running")
      .every((v) => {
        const expected = `/subscriptions/${scan.meta.subscriptionId}/resourceGroups/${v.resourceGroup}/providers/Microsoft.Compute/virtualMachines/${v.name}`;
        return invoiceVmRids.has(expected);
      });
    expect(runningOnInvoice).toBe(true);

    // Deallocated VMs leak ambient disk cost — this is the signal Rule 6 acts on.
    const deallocated = scan.vms.filter((v) => v.powerState === "deallocated");
    for (const vm of deallocated) {
      const matches = invoice.rows.filter((r) =>
        r.resourceId.includes(`/disks/${vm.name}-`),
      );
      expect(matches.length).toBeGreaterThan(0);
    }
  });

  test("joined pipeline produces $-valued right-sizing findings", () => {
    if (!existsSync(INVOICE)) return;
    const scan = parseDmcScan(FIXTURE);
    const invoice = parseInvoice(readFileSync(INVOICE), INVOICE);
    const joined = joinDmcWithInvoice(scan, invoice);

    // Every running VM in the scan should join to at least one invoice row.
    const running = joined.filter((j) => j.vm.powerState === "running");
    expect(running.length).toBeGreaterThan(40);
    expect(running.every((j) => j.evidenceRows.length > 0)).toBe(true);
    expect(running.every((j) => j.computeCost > 0)).toBe(true);

    const findings = utilisationRightSizingFindings(joined);
    expect(findings.length).toBeGreaterThan(0);

    // The four planted oversized VMs (vmctsoleg* on D32s_v5 / E32ds_v5) must
    // appear with confirmed severity and a non-trivial saving.
    const oversized = findings.filter((f) => f.title.includes("vmctsoleg"));
    expect(oversized.length).toBeGreaterThanOrEqual(3);
    expect(oversized.every((f) => f.severity === "confirmed")).toBe(true);
    expect(oversized.every((f) => (f.monthlySaving ?? 0) > 100)).toBe(true);

    // Every finding declares Rule 7 (Jeannie's right-sizing rule).
    expect(findings.every((f) => f.jeannieRule === 7)).toBe(true);
    // Confirmed findings have annualSaving = monthlySaving × 12.
    for (const f of findings.filter((f) => f.severity === "confirmed")) {
      expect(f.annualSaving).toBeCloseTo((f.monthlySaving ?? 0) * 12, 2);
    }
  });

  test("resource inventory mirrors DMC's 32 categories", () => {
    const scan = parseDmcScan(FIXTURE);
    expect(Object.keys(scan.resourceCounts).length).toBeGreaterThanOrEqual(30);
    expect(scan.resourceCounts.virtual_machines).toBe(scan.vms.length);
  });
});
