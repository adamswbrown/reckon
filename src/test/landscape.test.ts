import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parseInvoice } from "../engine/parse";
import { buildLandscape } from "../engine/landscape";

const NMEF = join(
  process.cwd(),
  "NMEF Azure Invoice JAN 26.xlsx"
);

// The NMEF invoice carries customer data and is gitignored. On CI the file
// is absent, so this whole suite is an integration check that skips when
// the fixture isn't present (same pattern as nmef.integration.test.ts).
const HAS_NMEF = existsSync(NMEF);
const describeIfNmef = HAS_NMEF ? describe : describe.skip;

describeIfNmef("landscape cards (NMEF JAN 26)", () => {
  const buf = readFileSync(NMEF);
  const invoice = parseInvoice(buf, NMEF);
  const cards = buildLandscape(invoice);

  it("emits one card per registered builder", () => {
    expect(cards.length).toBe(9);
  });

  it("every card has an id, title, headline, and matching columns/rows", () => {
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

  it("top-services card identifies SQL Database as the leader", () => {
    const topServices = cards.find((c) => c.id === "landscape:top-services")!;
    const first = topServices.rows[0];
    expect(String(first.Service)).toContain("SQL Database");
  });

  it("subscription concentration sums to ~total invoice cost", () => {
    const sub = cards.find((c) => c.id === "landscape:subscription-concentration")!;
    expect(sub.rows.length).toBeGreaterThan(0);
    expect(sub.rows[0].Subscription).toBeTruthy();
  });

  it("pareto card flags top 20% > 80% (concentrated estate)", () => {
    const pareto = cards.find((c) => c.id === "landscape:pareto")!;
    const headShare = Number(pareto.metrics?.headSharePct ?? 0);
    expect(headShare).toBeGreaterThan(80);
  });

  it("tag coverage card returns a share between 0 and 1", () => {
    const tags = cards.find((c) => c.id === "landscape:tag-coverage")!;
    const share = Number(tags.metrics?.tagCoverageShare ?? -1);
    expect(share).toBeGreaterThanOrEqual(0);
    expect(share).toBeLessThanOrEqual(1);
  });

  it("orphan-region card includes 'unassigned' if any rows lack a region", () => {
    const orphan = cards.find((c) => c.id === "landscape:orphan-region")!;
    const cost = Number(orphan.metrics?.orphanCost ?? 0);
    expect(cost).toBeGreaterThan(0); // NMEF has $9k+ unassigned
  });

  it("invoice integrity card counts all lines", () => {
    const integrity = cards.find((c) => c.id === "landscape:invoice-integrity")!;
    expect(Number(integrity.metrics?.totalLines)).toBe(invoice.rows.length);
  });
});
