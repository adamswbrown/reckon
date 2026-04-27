/**
 * Electron main process. The engine runs here (Node side); the renderer
 * is a sandboxed UI that talks to it via the IPC surface defined in
 * src/preload/preload.ts.
 *
 * State model: a single "current analysis" is held in memory after a file
 * is parsed. The renderer asks for HTML/CSV/saves against that result.
 * Re-analysing replaces it.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";

import { parseInvoice } from "../engine/parse";
import { analyse, type AnalysisResult } from "../engine/index";
import { renderHtml, type Audience } from "../render/html";
import { renderCsv } from "../render/csv";
import { renderSlides } from "../render/slides";
import { parseDmcScan } from "../dmc/parse";
import { extractDmcZip } from "../dmc/zip";
import type { DmcScan } from "../dmc/types";
import type { ParsedInvoice } from "../types";

let current: { result: AnalysisResult; sourcePath: string } | null = null;
let invoiceState: { invoice: ParsedInvoice; sourcePath: string } | null = null;
let dmcState: { scan: DmcScan; sourcePath: string; cleanup: () => void } | null = null;

function recompute(): AnalysisResult | null {
  if (!invoiceState) return null;
  const result = analyse(
    invoiceState.invoice,
    dmcState ? { dmcScan: dmcState.scan } : {},
  );
  current = { result, sourcePath: invoiceState.sourcePath };
  return result;
}

function summarise(result: AnalysisResult, sourcePath: string) {
  return {
    sourceFile: basename(sourcePath),
    customerName: result.invoice.customerName,
    period: result.invoice.period,
    displayCurrency: result.invoice.displayCurrency,
    totalCost: result.invoice.totalCost.amount,
    totalCostUsd: result.invoice.totalCostUsd.amount,
    rowCount: result.invoice.rows.length,
    immediateWinsMonthly: result.immediateWinsMonthly,
    validation: result.validation,
    findings: result.findings.map((f) => ({
      id: f.id,
      order: f.order,
      title: f.title,
      category: f.category,
      jeannieRule: f.jeannieRule,
      severity: f.severity,
      confidence: f.confidence,
      monthlySaving: f.monthlySaving,
      monthlySavingRange: f.monthlySavingRange,
      annualSaving: f.annualSaving,
      effort: f.effort,
      evidenceCount: f.evidence.length,
    })),
    dmc: dmcState
      ? {
          loaded: true,
          subscriptionId: dmcState.scan.meta.subscriptionId,
          subscriptionName: dmcState.scan.meta.subscriptionName,
          vmCount: dmcState.scan.vms.length,
          runningVms: dmcState.scan.vms.filter((v) => v.powerState === "running").length,
          windowDays: dmcState.scan.vms[0]?.collectionDays ?? null,
        }
      : { loaded: false as const },
  };
}

function periodSlug(): string {
  return current?.result.invoice.period.startDate.slice(0, 7) ?? "unknown";
}

function customerSlug(override?: string): string {
  const name = override?.trim() || current?.result.invoice.customerName || "customer";
  return name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0e0e0f",
    icon: resolve(__dirname, "../../build/icon.png"),
    show: false,
    webPreferences: {
      preload: resolve(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  if (!app.isPackaged) win.webContents.openDevTools({ mode: "detach" });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadFile(resolve(__dirname, "../renderer/index.html"));
}

ipcMain.handle("dialog:openInvoice", async () => {
  const r = await dialog.showOpenDialog({
    title: "Select Azure cost export",
    properties: ["openFile"],
    filters: [
      { name: "Azure cost export", extensions: ["xlsx", "csv"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return r.filePaths[0];
});

ipcMain.handle("analyse:file", async (_e, filePath: string) => {
  const buf = readFileSync(filePath);
  const invoice = parseInvoice(buf, filePath);
  invoiceState = { invoice, sourcePath: filePath };
  const result = recompute();
  if (!result) throw new Error("recompute failed: invoice missing");
  return summarise(result, filePath);
});

/**
 * Pick a DMC zip and return its path; password is collected separately
 * (renderer-side input) before `dmc:loadZip` is invoked.
 */
ipcMain.handle("dialog:openDmcZip", async () => {
  const r = await dialog.showOpenDialog({
    title: "Select DMC scan archive (zip)",
    properties: ["openFile"],
    filters: [
      { name: "Zip archive", extensions: ["zip"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return r.filePaths[0];
});

/**
 * Load and decrypt a DMC scan zip, parse it, store it alongside the
 * invoice (if any), and return an updated AnalysisSummary. If no
 * invoice is loaded yet, returns null — the renderer should prompt
 * the user to load the invoice first (or hold the DMC and re-render
 * on next invoice load — currently the simpler path is enforced).
 */
ipcMain.handle("dmc:loadZip", async (_e, zipPath: string, password: string) => {
  // Replace any prior DMC state and clean up its temp dir first.
  if (dmcState) {
    try { dmcState.cleanup(); } catch { /* best-effort */ }
    dmcState = null;
  }
  const extracted = await extractDmcZip(zipPath, password);
  try {
    const scan = parseDmcScan(extracted.scanRoot);
    dmcState = { scan, sourcePath: zipPath, cleanup: extracted.cleanup };
  } catch (err) {
    extracted.cleanup();
    throw err;
  }
  if (!invoiceState) {
    // Held in memory; once the invoice loads, recompute will fold this in.
    return { dmcLoaded: true, awaitingInvoice: true };
  }
  const result = recompute();
  if (!result) throw new Error("recompute failed after DMC load");
  return { dmcLoaded: true, summary: summarise(result, invoiceState.sourcePath) };
});

ipcMain.handle("dmc:clear", () => {
  if (dmcState) {
    try { dmcState.cleanup(); } catch { /* best-effort */ }
    dmcState = null;
  }
  if (invoiceState) {
    const result = recompute();
    if (result) return { cleared: true, summary: summarise(result, invoiceState.sourcePath) };
  }
  return { cleared: true };
});

ipcMain.handle("render:html", (_e, audience: Audience, customerNameOverride?: string) => {
  if (!current) return null;
  const out = renderHtml(current.result, { audience, customerNameOverride });
  return { html: out.html, filename: out.filename };
});

ipcMain.handle("export:html", async (_e, audience: Audience, customerNameOverride?: string) => {
  if (!current) return { saved: false };
  const out = renderHtml(current.result, { audience, customerNameOverride });
  const r = await dialog.showSaveDialog({
    title: "Save HTML report",
    defaultPath: out.filename,
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (r.canceled || !r.filePath) return { saved: false };
  writeFileSync(r.filePath, out.html);
  return { saved: true, path: r.filePath };
});

ipcMain.handle("export:csv", async (_e, customerNameOverride?: string) => {
  if (!current) return { saved: false };
  const csv = renderCsv(current.result.findings, {
    customerName: customerNameOverride?.trim() || current.result.invoice.customerName,
    period: periodSlug(),
  });
  const r = await dialog.showOpenDialog({
    title: "Choose folder for CSVs",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || r.filePaths.length === 0) return { saved: false };
  const dir = r.filePaths[0]!;
  const findingsPath = resolve(dir, csv.findingsFilename);
  const evidencePath = resolve(dir, csv.evidenceFilename);
  writeFileSync(findingsPath, csv.findingsCsv);
  writeFileSync(evidencePath, csv.evidenceCsv);
  return { saved: true, findingsPath, evidencePath };
});

ipcMain.handle("export:all", async (_e, customerNameOverride?: string) => {
  if (!current) return { saved: false };
  const r = await dialog.showOpenDialog({
    title: "Choose folder for full export",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || r.filePaths.length === 0) return { saved: false };
  const dir = r.filePaths[0]!;
  const csv = renderCsv(current.result.findings, {
    customerName: customerNameOverride?.trim() || current.result.invoice.customerName,
    period: periodSlug(),
  });
  writeFileSync(resolve(dir, csv.findingsFilename), csv.findingsCsv);
  writeFileSync(resolve(dir, csv.evidenceFilename), csv.evidenceCsv);
  const audiences: Audience[] = ["customer", "consultant", "informational"];
  const htmlPaths: string[] = [];
  for (const a of audiences) {
    const out = renderHtml(current.result, { audience: a, customerNameOverride });
    const p = resolve(dir, out.filename);
    writeFileSync(p, out.html);
    htmlPaths.push(p);
  }
  // Slide deck — same data set, different rendering.
  const slides = renderSlides(current.result, { customerNameOverride });
  const slidesPath = resolve(dir, slides.filename);
  writeFileSync(slidesPath, slides.html);
  return { saved: true, dir, htmlPaths, slidesPath, findingsPath: resolve(dir, csv.findingsFilename) };
});

ipcMain.handle("shell:reveal", (_e, p: string) => {
  shell.showItemInFolder(p);
});

/**
 * Generate the consulting-style slide deck artefact. Pure TypeScript —
 * no external runtime, no shell-out, works the same on macOS and Windows.
 */
ipcMain.handle("export:slides", async (_e, customerNameOverride?: string) => {
  if (!current) return { saved: false };

  const out = renderSlides(current.result, { customerNameOverride });
  const r = await dialog.showSaveDialog({
    title: "Save slide deck",
    defaultPath: out.filename,
    filters: [{ name: "HTML slide deck", extensions: ["html"] }],
  });
  if (r.canceled || !r.filePath) return { saved: false };

  try {
    writeFileSync(r.filePath, out.html);
    return { saved: true, path: r.filePath };
  } catch (err) {
    return { saved: false, error: (err as Error).message };
  }
});

void app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
