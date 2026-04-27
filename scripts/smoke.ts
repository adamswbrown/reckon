/**
 * End-to-end smoke test: parse a real invoice, run the engine, dump
 * every artefact (CSV, three audience HTML reports, slide deck) into
 * `out/`. Useful for confirming the full pipeline works on a fresh
 * change.
 *
 * Run with: `npm run engine:smoke`
 *
 * Drop any Azure cost-export `.xlsx` into the project root and this
 * picks it up automatically. Override the path via the
 * `RECKON_TEST_INVOICE` env var if you want to point at one elsewhere.
 *
 * Useful to confirm:
 *   - parser handles a real Azure export
 *   - rules trigger at all
 *   - validator produces a sensible report
 *   - every renderer writes successfully
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseInvoice } from "../src/engine/parse";
import { analyse, type AnalysisInputs } from "../src/engine/index";
import { renderCsv } from "../src/render/csv";
import { renderHtml } from "../src/render/html";
import { renderSlides } from "../src/render/slides";
import { findTestInvoice } from "../src/test/_helpers/findInvoice";
import { parseDmcScan } from "../src/dmc/parse";

const OUT_DIR = resolve(process.cwd(), "out");

function main(): void {
  const invoicePath = findTestInvoice();
  if (!invoicePath) {
    console.error(
      "No invoice found. Drop an Azure cost-export `.xlsx` into the project root, " +
        "or set RECKON_TEST_INVOICE=/path/to/invoice.xlsx and try again.",
    );
    process.exit(1);
  }

  console.log(`Reading ${invoicePath}`);
  const buf = readFileSync(invoicePath);
  const invoice = parseInvoice(buf, invoicePath);

  console.log(`Customer:      ${invoice.customerName}`);
  console.log(
    `Period:        ${invoice.period.startDate} → ${invoice.period.endDate} (${invoice.period.hoursInPeriod}h)`,
  );
  console.log(`Display ccy:   ${invoice.displayCurrency}`);
  console.log(`Total cost:    ${invoice.totalCost.amount.toFixed(2)} ${invoice.displayCurrency}`);
  console.log(`Total cost USD:${invoice.totalCostUsd.amount.toFixed(2)}`);
  console.log(`Rows:          ${invoice.rows.length}`);
  console.log("");

  // Optional DMC scan — picked up via env var or implied by the well-known
  // synthetic fixture path. Unloaded → invoice-only mode (untouched).
  const dmcDir = process.env.RECKON_TEST_DMC_SCAN
    ?? (existsSync("test-fixtures/dmc-azure-contoso") ? "test-fixtures/dmc-azure-contoso" : null);
  const inputs: AnalysisInputs = {};
  if (dmcDir) {
    const scan = parseDmcScan(resolve(dmcDir));
    inputs.dmcScan = scan;
    console.log(`DMC scan:      ${scan.vms.length} VMs (${scan.vms.filter((v) => v.powerState === "running").length} running, ${scan.vms[0]?.collectionDays ?? "?"}d window)`);
    console.log("");
  }

  const result = analyse(invoice, inputs);
  console.log(`Findings:               ${result.findings.length}`);
  console.log(`  confirmed:            ${result.findings.filter((f) => f.severity === "confirmed").length}`);
  console.log(`  conditional:          ${result.findings.filter((f) => f.severity === "conditional").length}`);
  console.log(`  investigate:          ${result.findings.filter((f) => f.severity === "investigate").length}`);
  console.log(
    `Immediate-wins monthly: ${result.immediateWinsMonthly.toFixed(2)} ${invoice.displayCurrency}`,
  );
  console.log(`Validation OK:          ${result.validation.ok}`);
  if (result.validation.issues.length > 0) {
    console.log("Validation issues:");
    for (const i of result.validation.issues) {
      console.log(`  [${i.level}] ${i.code}: ${i.message}`);
    }
  }
  console.log("");

  console.log("Top 10 findings by order:");
  for (const f of result.findings.slice(0, 10)) {
    const saving =
      f.monthlySaving !== null
        ? `${f.monthlySaving.toFixed(2)}/mo`
        : f.monthlySavingRange
          ? `${f.monthlySavingRange[0].toFixed(2)}–${f.monthlySavingRange[1].toFixed(2)}/mo`
          : "—";
    console.log(
      `  #${f.order.toString().padStart(2)} [R${f.jeannieRule}] ${f.severity.padEnd(11)} ${saving.padStart(20)}  ${f.title}`,
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const csv = renderCsv(result.findings, {
    customerName: invoice.customerName,
    period: invoice.period.startDate.slice(0, 7),
  });
  writeFileSync(resolve(OUT_DIR, csv.findingsFilename), csv.findingsCsv);
  writeFileSync(resolve(OUT_DIR, csv.evidenceFilename), csv.evidenceCsv);
  console.log("");
  console.log(`Wrote out/${csv.findingsFilename}`);
  console.log(`Wrote out/${csv.evidenceFilename}`);

  // Render all three audiences so the differences can be eyeballed.
  for (const audience of ["customer", "consultant", "informational"] as const) {
    const html = renderHtml(result, { audience });
    writeFileSync(resolve(OUT_DIR, html.filename), html.html);
    console.log(`Wrote out/${html.filename} (${(html.html.length / 1024).toFixed(1)} KB)`);
  }

  // Slide deck — pure TypeScript, same data set, different rendering.
  const slides = renderSlides(result);
  writeFileSync(resolve(OUT_DIR, slides.filename), slides.html);
  console.log(`Wrote out/${slides.filename} (${(slides.html.length / 1024).toFixed(1)} KB)`);
}

main();
