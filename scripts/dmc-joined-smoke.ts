/**
 * End-to-end smoke for the joined DMC + invoice pipeline.
 *
 * Reads the synthetic Contoso DMC scan and matching invoice, runs the
 * existing invoice-only engine, layers the utilisation-backed
 * right-sizing rule on top, and prints a summary of what changed.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseInvoice } from "../src/engine/parse";
import { analyse } from "../src/engine/index";
import { parseDmcScan } from "../src/dmc/parse";
import { renderSlides } from "../src/render/slides";
import { fmtMoney } from "../src/render/escape";
import type { Finding } from "../src/types";

function fmt(n: number, ccy: string): string {
  return fmtMoney(n, ccy);
}

function bySeverity(fs: Finding[]) {
  return {
    confirmed: fs.filter((f) => f.severity === "confirmed").length,
    conditional: fs.filter((f) => f.severity === "conditional").length,
    investigate: fs.filter((f) => f.severity === "investigate").length,
  };
}

function totalMonthly(fs: Finding[]): number {
  return fs.reduce((s, f) => s + (f.monthlySaving ?? 0), 0);
}

function main() {
  const scanDir = process.argv[2] ?? "test-fixtures/dmc-azure-contoso";
  const invoicePath = process.argv[3] ?? "test-fixtures/Contoso_Azure_Invoice_2026Q1.xlsx";

  const scan = parseDmcScan(resolve(scanDir));
  const invoice = parseInvoice(readFileSync(resolve(invoicePath)), invoicePath);
  const baseline = analyse(invoice);
  const joinedResult = analyse(invoice, { dmcScan: scan });
  const rightSizing = joinedResult.findings.filter((f) => f.jeannieRule === 7 && /^Right-size /.test(f.title));

  console.log("\nJOINED PIPELINE — DMC scan + invoice");
  console.log("─".repeat(72));
  console.log(`Customer:      ${invoice.customerName}`);
  console.log(`Subscription:  ${scan.meta.subscriptionId}`);
  console.log(`Invoice total: ${fmt(invoice.totalCost.amount, invoice.displayCurrency)}`);
  console.log(`VMs in scan:   ${scan.vms.length} (${scan.vms.filter((v) => v.powerState === "running").length} running)`);

  console.log("\nINVOICE-ONLY (today's pipeline):");
  const inv = bySeverity(baseline.findings);
  console.log(`  ${baseline.findings.length} findings — ${inv.confirmed} confirmed, ${inv.conditional} conditional, ${inv.investigate} investigate`);
  console.log(`  immediate wins: ${fmt(baseline.immediateWinsMonthly, invoice.displayCurrency)}/mo`);

  console.log("\nUTILISATION-BACKED right-sizing (NEW, from joined data):");
  const rs = bySeverity(rightSizing);
  console.log(`  ${rightSizing.length} findings — ${rs.confirmed} confirmed, ${rs.conditional} conditional`);
  console.log(`  recoverable:    ${fmt(totalMonthly(rightSizing), invoice.displayCurrency)}/mo (${fmt(totalMonthly(rightSizing) * 12, invoice.displayCurrency)}/yr)`);

  console.log("\nTop right-sizing actions:");
  for (const f of rightSizing.slice(0, 8)) {
    const sev = f.severity === "confirmed" ? "✓ CONFIRMED " : "? CONDITIONAL";
    console.log(`  ${sev}  ${fmt(f.monthlySaving ?? 0, invoice.displayCurrency).padStart(13)}/mo  ${f.title}`);
  }

  console.log("\nCOMBINED VIEW (invoice + DMC, via analyse({ dmcScan })):");
  const totals = bySeverity(joinedResult.findings);
  console.log(`  ${joinedResult.findings.length} findings total — ${totals.confirmed} confirmed, ${totals.conditional} conditional, ${totals.investigate} investigate`);
  console.log(`  immediate wins: ${fmt(joinedResult.immediateWinsMonthly, invoice.displayCurrency)}/mo`);
  console.log(`  annualised:     ${fmt(joinedResult.immediateWinsMonthly * 12, invoice.displayCurrency)}/yr`);
  console.log(`  validation:     ${joinedResult.validation.ok ? "OK" : "ISSUES"}`);

  // Render the slide deck so the per-VM right-sizing slide is visible.
  mkdirSync("out", { recursive: true });
  const slides = renderSlides(joinedResult);
  writeFileSync(resolve("out", slides.filename), slides.html);
  console.log(`\nWrote out/${slides.filename} (${(slides.html.length / 1024).toFixed(1)} KB)`);
}

main();
