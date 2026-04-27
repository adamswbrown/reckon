/**
 * Renderer logic. No node, no engine imports — only window.api (preload).
 */

export {}; // make this a module so `declare global` works

// Types kept local to keep this file self-contained (no cross-rootDir imports).
type Audience = "customer" | "consultant" | "informational";

interface FindingSummary {
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

type DmcStatus =
  | { loaded: false }
  | {
      loaded: true;
      subscriptionId: string;
      subscriptionName: string;
      vmCount: number;
      runningVms: number;
      windowDays: number | null;
    };

interface AnalysisSummary {
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

interface DmcLoadResult {
  dmcLoaded: true;
  awaitingInvoice?: boolean;
  summary?: AnalysisSummary;
}

interface Api {
  pickInvoice: () => Promise<string | null>;
  analyseFile: (path: string) => Promise<AnalysisSummary>;
  pickDmcZip: () => Promise<string | null>;
  loadDmcZip: (path: string, password: string) => Promise<DmcLoadResult>;
  clearDmc: () => Promise<{ cleared: true; summary?: AnalysisSummary }>;
  renderHtml: (audience: Audience, customerNameOverride?: string) => Promise<{ html: string; filename: string } | null>;
  exportHtml: (audience: Audience, customerNameOverride?: string) => Promise<{ saved: boolean; path?: string }>;
  exportCsv: (customerNameOverride?: string) => Promise<{ saved: boolean; findingsPath?: string; evidencePath?: string }>;
  exportAll: (customerNameOverride?: string) => Promise<{ saved: boolean; dir?: string; htmlPaths?: string[]; findingsPath?: string }>;
  exportSlides: (customerNameOverride?: string) => Promise<{ saved: boolean; path?: string; error?: string }>;
  reveal: (path: string) => Promise<void>;
}

declare global {
  interface Window {
    api: Api;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const dropZone = $("dropZone");
const pickBtn = $<HTMLButtonElement>("pickBtn");
const filePicked = $("filePicked");
const customerOverride = $<HTMLInputElement>("customerOverride");
const audienceSeg = $("audienceSeg");
const analyseBtn = $<HTMLButtonElement>("analyseBtn");
const exportCard = $("exportCard");
const exportHtmlBtn = $<HTMLButtonElement>("exportHtmlBtn");
const exportCsvBtn = $<HTMLButtonElement>("exportCsvBtn");
const exportAllBtn = $<HTMLButtonElement>("exportAllBtn");
const exportSlidesBtn = $<HTMLButtonElement>("exportSlidesBtn");
const exportStatus = $("exportStatus");
const preview = $<HTMLIFrameElement>("preview");
const previewEmpty = $("previewEmpty");
const previewMeta = $("previewMeta");
const findingsCount = $("findingsCount");
const validationPill = $("validationPill");
const findingsHeadline = $("findingsHeadline");
const hlAmount = $("hlAmount");
const findingsList = $<HTMLOListElement>("findingsList");
const toast = $("toast");
const dmcPickBtn = $<HTMLButtonElement>("dmcPickBtn");
const dmcFilePicked = $("dmcFilePicked");
const dmcPassword = $<HTMLInputElement>("dmcPassword");
const dmcLoadBtn = $<HTMLButtonElement>("dmcLoadBtn");
const dmcStatus = $("dmcStatus");
const dmcClearBtn = $<HTMLButtonElement>("dmcClearBtn");

let pickedPath: string | null = null;
let pickedDmcPath: string | null = null;
let summary: AnalysisSummary | null = null;
let audience: Audience = "consultant";

function refreshDmcLoadEnabled(): void {
  dmcLoadBtn.disabled = !pickedDmcPath || dmcPassword.value.trim().length === 0;
}

dmcPickBtn.addEventListener("click", async () => {
  const p = await window.api.pickDmcZip();
  if (!p) return;
  pickedDmcPath = p;
  dmcFilePicked.textContent = p.split("/").pop() ?? p;
  refreshDmcLoadEnabled();
});

dmcPassword.addEventListener("input", refreshDmcLoadEnabled);

dmcLoadBtn.addEventListener("click", async () => {
  if (!pickedDmcPath) return;
  dmcLoadBtn.disabled = true;
  dmcLoadBtn.textContent = "Decrypting…";
  dmcStatus.textContent = "";
  try {
    const r = await window.api.loadDmcZip(pickedDmcPath, dmcPassword.value);
    if (r.awaitingInvoice) {
      dmcStatus.textContent = "DMC scan held. Load the invoice to fold utilisation in.";
    } else if (r.summary) {
      summary = r.summary;
      paintSummary(r.summary);
      await refreshPreview();
      const d = r.summary.dmc;
      dmcStatus.textContent = d.loaded
        ? `Loaded ${d.vmCount} VMs (${d.runningVms} running) — ${d.windowDays ?? "?"}d window`
        : "Loaded";
      showToast("DMC scan joined to invoice");
    }
    dmcPassword.value = "";
    dmcClearBtn.hidden = false;
  } catch (err) {
    dmcStatus.textContent = (err as Error).message;
    showToast(`DMC load failed: ${(err as Error).message}`);
  } finally {
    dmcLoadBtn.textContent = "Load DMC scan";
    refreshDmcLoadEnabled();
  }
});

dmcClearBtn.addEventListener("click", async () => {
  const r = await window.api.clearDmc();
  if (r.summary) {
    summary = r.summary;
    paintSummary(r.summary);
    await refreshPreview();
  }
  dmcStatus.textContent = "";
  dmcFilePicked.textContent = "No archive selected";
  pickedDmcPath = null;
  dmcClearBtn.hidden = true;
  refreshDmcLoadEnabled();
  showToast("DMC scan removed");
});

function setPickedPath(p: string | null): void {
  pickedPath = p;
  filePicked.textContent = p ? p.split("/").pop() ?? p : "No file selected";
  analyseBtn.disabled = !p;
}

pickBtn.addEventListener("click", async () => {
  const p = await window.api.pickInvoice();
  if (p) setPickedPath(p);
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const f = e.dataTransfer?.files?.[0];
  // Electron exposes path on dropped File objects
  const p = (f as unknown as { path?: string } | undefined)?.path;
  if (p) setPickedPath(p);
});

audienceSeg.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-aud]");
  if (!btn) return;
  const aud = btn.dataset.aud as Audience | undefined;
  if (!aud || aud === audience) return;
  audience = aud;
  for (const b of audienceSeg.querySelectorAll<HTMLButtonElement>("button")) {
    b.classList.toggle("active", b.dataset.aud === aud);
  }
  if (summary) void refreshPreview();
});

analyseBtn.addEventListener("click", async () => {
  if (!pickedPath) return;
  analyseBtn.disabled = true;
  analyseBtn.textContent = "Analysing…";
  try {
    const s = await window.api.analyseFile(pickedPath);
    summary = s;
    paintSummary(s);
    await refreshPreview();
    exportCard.hidden = false;
    showToast(`Analysed ${s.findings.length} findings`);
  } catch (err) {
    console.error("analyse failed", err);
    showToast(`Failed: ${(err as Error).message}`);
  } finally {
    analyseBtn.textContent = "Re-analyse";
    analyseBtn.disabled = false;
  }
});

function paintSummary(s: AnalysisSummary): void {
  findingsCount.textContent = String(s.findings.length);
  validationPill.textContent = s.validation.ok ? "validated" : `${s.validation.issues.length} issues`;
  validationPill.dataset.state = s.validation.ok ? "ok" : s.validation.issues.some((i) => i.level === "error") ? "bad" : "warn";

  if (s.immediateWinsMonthly > 0) {
    findingsHeadline.hidden = false;
    hlAmount.textContent = fmtMoney(s.immediateWinsMonthly, s.displayCurrency);
  } else {
    findingsHeadline.hidden = true;
  }

  findingsList.innerHTML = "";
  for (const f of s.findings) findingsList.appendChild(findingRow(f, s.displayCurrency));

  const dmcLine = s.dmc.loaded
    ? ` · DMC: ${s.dmc.vmCount} VMs (${s.dmc.runningVms} running, ${s.dmc.windowDays ?? "?"}d)`
    : "";
  previewMeta.textContent = `${s.customerName} · ${s.period.startDate.slice(0, 7)} · ${s.rowCount.toLocaleString()} rows · ${fmtMoney(s.totalCost, s.displayCurrency)}${dmcLine}`;

  if (!customerOverride.value.trim()) customerOverride.placeholder = s.customerName;
}

function findingRow(f: FindingSummary, ccy: string): HTMLLIElement {
  const li = document.createElement("li");
  li.dataset.id = f.id;

  const ord = document.createElement("div");
  ord.className = "f-order";
  ord.textContent = `#${f.order}`;

  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "f-title";
  title.textContent = f.title;
  body.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "f-meta";
  const sev = document.createElement("span");
  sev.className = `sev sev-${f.severity}`;
  sev.textContent = f.severity;
  meta.appendChild(sev);
  const j = document.createElement("span");
  j.className = "j-rule";
  j.textContent = `J${f.jeannieRule}`;
  meta.appendChild(j);
  body.appendChild(meta);

  const sav = document.createElement("div");
  sav.className = "f-saving";
  sav.textContent = formatSaving(f, ccy);

  li.append(ord, body, sav);

  li.addEventListener("click", () => scrollPreviewTo(f.id));
  return li;
}

function formatSaving(f: FindingSummary, ccy: string): string {
  if (f.monthlySaving !== null) return `${fmtMoney(f.monthlySaving, ccy)}/mo`;
  if (f.monthlySavingRange) return `${fmtMoney(f.monthlySavingRange[0], ccy)}–${fmtMoney(f.monthlySavingRange[1], ccy)}/mo`;
  return "—";
}

function fmtMoney(n: number, ccy: string): string {
  const abs = Math.abs(n);
  const formatted = abs >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2);
  return `${ccy === "USD" ? "$" : ccy === "GBP" ? "£" : ccy === "EUR" ? "€" : ccy + " "}${formatted}`;
}

async function refreshPreview(): Promise<void> {
  const out = await window.api.renderHtml(audience, customerOverride.value || undefined);
  if (!out) return;
  previewEmpty.hidden = true;
  // Force a fresh navigation in the iframe — setting srcdoc twice in a tick
  // doesn't always re-render in Chromium, so swap to about:blank first.
  preview.removeAttribute("srcdoc");
  preview.src = "about:blank";
  requestAnimationFrame(() => {
    preview.removeAttribute("src");
    preview.srcdoc = out.html;
  });
}

function scrollPreviewTo(id: string): void {
  const doc = preview.contentDocument;
  if (!doc) return;
  const el = doc.getElementById(id) ?? doc.querySelector(`[data-finding-id="${id}"]`);
  if (el && "scrollIntoView" in el) {
    (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

exportHtmlBtn.addEventListener("click", async () => {
  const r = await window.api.exportHtml(audience, customerOverride.value || undefined);
  if (r.saved && r.path) {
    setExportStatus(`Saved ${r.path}`);
    void window.api.reveal(r.path);
  }
});
exportCsvBtn.addEventListener("click", async () => {
  const r = await window.api.exportCsv(customerOverride.value || undefined);
  if (r.saved && r.findingsPath) {
    setExportStatus(`Saved CSVs to ${r.findingsPath.split("/").slice(0, -1).join("/")}`);
    void window.api.reveal(r.findingsPath);
  }
});
exportSlidesBtn.addEventListener("click", async () => {
  exportSlidesBtn.disabled = true;
  const original = exportSlidesBtn.textContent;
  exportSlidesBtn.textContent = "Generating…";
  try {
    const r = await window.api.exportSlides(customerOverride.value || undefined);
    if (r.saved && r.path) {
      setExportStatus(`Saved slide deck to ${r.path}`);
      void window.api.reveal(r.path);
    } else if (r.error) {
      setExportStatus(`Slide deck failed: ${r.error}`);
      showToast("Slide deck failed — check status panel");
    }
  } finally {
    exportSlidesBtn.textContent = original;
    exportSlidesBtn.disabled = false;
  }
});

exportAllBtn.addEventListener("click", async () => {
  const r = await window.api.exportAll(customerOverride.value || undefined);
  if (r.saved && r.dir) {
    setExportStatus(`Saved full export to ${r.dir}`);
    if (r.findingsPath) void window.api.reveal(r.findingsPath);
  }
});

function setExportStatus(msg: string): void {
  exportStatus.textContent = msg;
}

let toastTimer: number | undefined;
function showToast(msg: string): void {
  toast.textContent = msg;
  toast.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 2400);
}
