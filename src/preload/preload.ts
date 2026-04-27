/**
 * Preload — exposes a narrow IPC surface to the renderer via contextBridge.
 * Compiled to CommonJS (preload.cjs) because Electron preloads still want CJS.
 */

import { contextBridge, ipcRenderer } from "electron";

export interface FindingSummary {
  id: string;
  order: number;
  title: string;
  category: string;
  jeannieRule: number;
  severity: "confirmed" | "conditional" | "investigate";
  confidence: "high" | "medium" | "low";
  monthlySaving: number | null;
  monthlySavingRange?: [number, number];
  annualSaving: number | null;
  effort: "low" | "medium" | "high";
  evidenceCount: number;
}

export type DmcStatus =
  | { loaded: false }
  | {
      loaded: true;
      subscriptionId: string;
      subscriptionName: string;
      vmCount: number;
      runningVms: number;
      windowDays: number | null;
    };

export interface AnalysisSummary {
  sourceFile: string;
  customerName: string;
  period: { startDate: string; endDate: string; hoursInPeriod: number };
  displayCurrency: string;
  totalCost: number;
  totalCostUsd: number;
  rowCount: number;
  immediateWinsMonthly: number;
  validation: { ok: boolean; issues: { level: string; code: string; message: string }[] };
  findings: FindingSummary[];
  dmc: DmcStatus;
}

export interface DmcLoadResult {
  dmcLoaded: true;
  awaitingInvoice?: boolean;
  summary?: AnalysisSummary;
}

export type Audience = "customer" | "consultant" | "informational";

const api = {
  pickInvoice: (): Promise<string | null> => ipcRenderer.invoke("dialog:openInvoice"),
  analyseFile: (path: string): Promise<AnalysisSummary> => ipcRenderer.invoke("analyse:file", path),
  pickDmcZip: (): Promise<string | null> => ipcRenderer.invoke("dialog:openDmcZip"),
  loadDmcZip: (path: string, password: string): Promise<DmcLoadResult> =>
    ipcRenderer.invoke("dmc:loadZip", path, password),
  clearDmc: (): Promise<{ cleared: true; summary?: AnalysisSummary }> =>
    ipcRenderer.invoke("dmc:clear"),
  renderHtml: (audience: Audience, customerNameOverride?: string): Promise<{ html: string; filename: string } | null> =>
    ipcRenderer.invoke("render:html", audience, customerNameOverride),
  exportHtml: (audience: Audience, customerNameOverride?: string): Promise<{ saved: boolean; path?: string }> =>
    ipcRenderer.invoke("export:html", audience, customerNameOverride),
  exportCsv: (customerNameOverride?: string): Promise<{ saved: boolean; findingsPath?: string; evidencePath?: string }> =>
    ipcRenderer.invoke("export:csv", customerNameOverride),
  exportAll: (customerNameOverride?: string): Promise<{ saved: boolean; dir?: string; htmlPaths?: string[]; findingsPath?: string }> =>
    ipcRenderer.invoke("export:all", customerNameOverride),
  exportSlides: (customerNameOverride?: string): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke("export:slides", customerNameOverride),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke("shell:reveal", path),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
