/**
 * Synthetic landscape tests — exercise every card builder against
 * generic, hand-rolled invoice fixtures. These tests run on CI where
 * the NMEF customer fixture is unavailable, and they pin the contract
 * the landscape engine must satisfy for any Azure invoice, not just
 * the one customer we happen to have in hand.
 *
 * The NMEF-specific landscape suite (`landscape.test.ts`) acts as the
 * integration smoke test when the real fixture is present. This file
 * acts as the unit-level safety net.
 */

import { describe, expect, it } from "vitest";
import type { InvoiceRow, ParsedInvoice } from "../types";
import { buildLandscape } from "../engine/landscape";

function row(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    resourceId: "/subscriptions/sub-a/resourceGroups/rg-default/providers/Microsoft.Compute/virtualMachines/vm-a",
    resourceType: "microsoft.compute/virtualmachines",
    resourceLocation: "eastus",
    resourceGroupName: "rg-default",
    subscriptionName: "sub-a",
    serviceName: "Virtual Machines",
    meter: "D4s v5",
    tags: "",
    costUsd: 100,
    cost: 100,
    currency: "USD",
    ...overrides,
  };
}

function invoice(rows: InvoiceRow[], overrides: Partial<ParsedInvoice> = {}): ParsedInvoice {
  const total = rows.reduce((s, r) => s + r.cost, 0);
  return {
    customerName: "Synthetic Co",
    period: { startDate: "2026-01-01", endDate: "2026-01-31", hoursInPeriod: 744 },
    displayCurrency: "USD",
    rows,
    totalCost: { amount: total, currency: "USD" },
    totalCostUsd: { amount: total, currency: "USD" },
    sourceFile: "synthetic.xlsx",
    ...overrides,
  };
}

describe("buildLandscape — generic invoice contract", () => {
  it("returns the registered set of cards for a non-trivial invoice", () => {
    const cards = buildLandscape(
      invoice([
        row({ serviceName: "SQL Database", cost: 1000, meter: "vCore S2" }),
        row({ serviceName: "Virtual Machines", cost: 500 }),
        row({ serviceName: "Storage", cost: 250, resourceLocation: "westeurope" }),
        row({ serviceName: "Bandwidth", cost: 100, resourceLocation: "" }),
      ]),
    );
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.id).toMatch(/^landscape:/);
      expect(c.title).not.toBe("");
      expect(c.headline).not.toBe("");
      expect(c.columns.length).toBeGreaterThan(0);
      for (const r of c.rows) {
        for (const col of c.columns) {
          expect(r).toHaveProperty(col);
        }
      }
    }
  });

  it("top-services card identifies the dominant service by spend", () => {
    const cards = buildLandscape(
      invoice([
        row({ serviceName: "SQL Database", cost: 9000 }),
        row({ serviceName: "Virtual Machines", cost: 1000 }),
      ]),
    );
    const top = cards.find((c) => c.id === "landscape:top-services")!;
    expect(top).toBeDefined();
    expect(String(top.rows[0].Service)).toBe("SQL Database");
  });

  it("subscription concentration shows multiple subs when present", () => {
    const cards = buildLandscape(
      invoice([
        row({ subscriptionName: "sub-prod", cost: 8000 }),
        row({ subscriptionName: "sub-dev", cost: 2000 }),
      ]),
    );
    const sub = cards.find((c) => c.id === "landscape:subscription-concentration")!;
    expect(sub.rows.length).toBeGreaterThan(0);
    expect(sub.rows[0].Subscription).toBe("sub-prod");
  });

  it("pareto card flags concentrated spend (single service dominates)", () => {
    const cards = buildLandscape(
      invoice([
        row({ serviceName: "A", cost: 9500 }),
        row({ serviceName: "B", cost: 100 }),
        row({ serviceName: "C", cost: 100 }),
        row({ serviceName: "D", cost: 100 }),
        row({ serviceName: "E", cost: 100 }),
        row({ serviceName: "F", cost: 100 }),
      ]),
    );
    const pareto = cards.find((c) => c.id === "landscape:pareto");
    expect(pareto).toBeDefined();
    const headShare = Number(pareto!.metrics?.headSharePct ?? 0);
    expect(headShare).toBeGreaterThan(50);
  });

  it("tag coverage card returns a share between 0 and 1", () => {
    const cards = buildLandscape(
      invoice([
        row({ tags: '{"env":"prod"}', cost: 500 }),
        row({ tags: "", cost: 500 }),
      ]),
    );
    const tags = cards.find((c) => c.id === "landscape:tag-coverage")!;
    const share = Number(tags.metrics?.tagCoverageShare ?? -1);
    expect(share).toBeGreaterThanOrEqual(0);
    expect(share).toBeLessThanOrEqual(1);
  });

  it("orphan-region card surfaces unassigned regional spend", () => {
    const cards = buildLandscape(
      invoice([
        row({ resourceLocation: "eastus", cost: 800 }),
        row({ resourceLocation: "", cost: 200 }),
      ]),
    );
    const orphan = cards.find((c) => c.id === "landscape:orphan-region")!;
    const cost = Number(orphan.metrics?.orphanCost ?? -1);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("invoice integrity card counts every row supplied", () => {
    const inv = invoice([row(), row(), row()]);
    const cards = buildLandscape(inv);
    const integrity = cards.find((c) => c.id === "landscape:invoice-integrity")!;
    expect(Number(integrity.metrics?.totalLines)).toBe(inv.rows.length);
  });

  it("handles a degenerate empty invoice without throwing", () => {
    const cards = buildLandscape(invoice([]));
    expect(Array.isArray(cards)).toBe(true);
    for (const c of cards) {
      expect(c.id).toMatch(/^landscape:/);
    }
  });

  it("handles non-USD currency invoices", () => {
    const cards = buildLandscape(
      invoice([row({ cost: 500, costUsd: 600, currency: "GBP" })], {
        displayCurrency: "GBP",
        totalCost: { amount: 500, currency: "GBP" },
      }),
    );
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.title).not.toBe("");
  });
});
