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

let current: { result: AnalysisResult; sourcePath: string } | null = null;

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
  const result = analyse(invoice);
  current = { result, sourcePath: filePath };
  return {
    sourceFile: basename(filePath),
    customerName: invoice.customerName,
    period: invoice.period,
    displayCurrency: invoice.displayCurrency,
    totalCost: invoice.totalCost.amount,
    totalCostUsd: invoice.totalCostUsd.amount,
    rowCount: invoice.rows.length,
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
  };
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
