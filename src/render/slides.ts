/**
 * Customer-facing slide-deck renderer.
 *
 * Produces a self-contained HTML deck in the consulting register: action
 * titles on every slide, executive summary up front, conservative palette,
 * tracker chip pinned to the top, source line at the bottom of every data
 * slide.
 *
 * Operates directly on AnalysisResult (no HTML re-parsing). Customer
 * narratives are routed through `voiceFor("customer", ...)` so the deck
 * speaks in the same voice as the customer-audience report.
 *
 * Sixteen slides in a four-section arc:
 *   01 Snapshot   — Cover, Executive summary, Estate snapshot
 *   02 Approach   — Framework, three-lever pipeline
 *   03 Actions    — One slide per top finding, then sequencing
 *   04 Next steps — Limits, three-step plan, close
 */

import type { AnalysisResult } from "../engine/index";
import type { Finding } from "../types";
import { FRAMEWORK_RULES } from "../engine/framework";
import { esc, fmtMoney } from "./escape";
import { voiceFor, type VoiceContext } from "./voice";

export interface RenderSlidesOptions {
  customerNameOverride?: string;
}

export interface SlidesOutput {
  html: string;
  filename: string;
}

/* ---------------------------------------------------------------------- */
/* Selection logic                                                        */
/* ---------------------------------------------------------------------- */

function savingSortKey(f: Finding): number {
  if (f.monthlySaving !== null) return f.monthlySaving;
  if (f.monthlySavingRange) return f.monthlySavingRange[1];
  return 0;
}

function selectTopFindings(findings: Finding[], limit = 6): Finding[] {
  const actionable = findings.filter(
    (f) => f.severity === "confirmed" || f.severity === "conditional",
  );
  return [...actionable].sort((a, b) => savingSortKey(b) - savingSortKey(a)).slice(0, limit);
}

function splitByLever(findings: Finding[]): {
  hybrid: number;
  commitments: number;
  computePlans: number;
  operations: number;
} {
  let hybrid = 0;
  let commitments = 0;
  let computePlans = 0;
  let operations = 0;
  for (const f of findings) {
    if (f.jeannieRule === 2 || f.jeannieRule === 3) hybrid++;
    else if (f.jeannieRule === 4 || f.jeannieRule === 5) commitments++;
    else if (f.jeannieRule === 1) computePlans++;
    else operations++;
  }
  return { hybrid, commitments, computePlans, operations };
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

const RULE_LABEL: Record<number, string> = {
  1: "Compute commitment plan",
  2: "Hybrid Benefit",
  3: "Hybrid Benefit",
  4: "Reservation coverage",
  5: "Commitment term",
  6: "Operational sprawl",
  7: "Right-sizing pre-work",
  8: "Runtime profile",
  9: "Discovery question",
  10: "Severity discipline",
};

/** Plain-English principle names for the framework slide. */
const PRINCIPLES: Array<{ n: number; title: string; sub: string }> = [
  { n: 1, title: "Lever order is fixed", sub: "Hybrid Benefit first, commitments second, compute plans third" },
  { n: 2, title: "Two licensing layers", sub: "Windows is visible on the invoice; SQL is hidden in compute pricing" },
  { n: 3, title: "Eight-core threshold", sub: "Skip Hybrid Benefit on small VMs; rank survivors by core count" },
  { n: 4, title: "Reservations crawl", sub: "Scope, generation, and disk type all have to match" },
  { n: 5, title: "Three-year terms exchange", sub: "Commitments swap dollar-for-dollar if the workload changes" },
  { n: 6, title: "Sprawl is the signal", sub: "24/7 runtime is expected; leftover and dormant resources are not" },
  { n: 7, title: "The invoice answers where, not whether", sub: "Right-sizing requires utilisation data, not cost data" },
  { n: 8, title: "Reverse-engineer runtime from cost", sub: "Billed hours = PAYG cost ÷ hourly rate" },
  { n: 9, title: "Ask before recommending action", sub: "Discovery questions are mandatory wherever configuration matters" },
  { n: 10, title: "Severity is a contract", sub: "Confirmed counts toward totals; investigate is excluded by design" },
];

function annualised(f: Finding, currency: string): string {
  if (f.monthlySaving !== null) {
    return `${fmtMoney(Math.round(f.monthlySaving * 12), currency)}/yr`;
  }
  if (f.monthlySavingRange) {
    const [low, high] = f.monthlySavingRange;
    return `${fmtMoney(Math.round(low * 12), currency)}–${fmtMoney(Math.round(high * 12), currency)}/yr`;
  }
  return "observation";
}

function monthlyLabel(f: Finding, currency: string): string {
  if (f.monthlySaving !== null) return `${fmtMoney(f.monthlySaving, currency)}/mo`;
  if (f.monthlySavingRange) {
    const [low, high] = f.monthlySavingRange;
    return `${fmtMoney(low, currency)}–${fmtMoney(high, currency)}/mo`;
  }
  return "—";
}

function actionHeadline(f: Finding, currency: string): string {
  const value = annualised(f, currency);
  const lever = (RULE_LABEL[f.jeannieRule] ?? "Optimisation").toLowerCase();
  if (f.severity === "confirmed") {
    return `${value} is recoverable through ${lever} on this finding`;
  }
  if (f.severity === "conditional") {
    return `${value} opens up behind one decision: ${lever}`;
  }
  return `${RULE_LABEL[f.jeannieRule] ?? "Optimisation"}: signal worth a conversation`;
}

function principleName(n: number): string {
  return PRINCIPLES.find((p) => p.n === n)?.title ?? RULE_LABEL[n] ?? "Optimisation";
}

const SECTION_LABELS = ["01 Snapshot", "02 Approach", "03 Actions", "04 Next steps"] as const;

function tracker(activeIdx: number): string {
  return `<nav class="tracker" aria-label="Section tracker">${SECTION_LABELS.map((label, i) => {
    const cls = "tracker__item" + (i === activeIdx ? " tracker__item--active" : "");
    return `<span class="${cls}">${esc(label)}</span>`;
  }).join("")}</nav>`;
}

function sourceLine(periodLabel: string, rowsCount: number, extra = ""): string {
  const base = `Source: Azure cost analysis export, ${esc(periodLabel)}; ${rowsCount.toLocaleString()} rows`;
  const tail = extra ? `. ${esc(extra)}` : "";
  return `<div class="source-line">${base}${tail}</div>`;
}

function sanitiseFilenamePart(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/* ---------------------------------------------------------------------- */
/* Individual slides                                                      */
/* ---------------------------------------------------------------------- */

function slideCover(customer: string, periodShort: string, periodLabel: string): string {
  return `
  <section class="slide slide--cover">
    <div class="cover__rule"></div>
    <div class="cover__inner">
      <p class="slide__eyebrow reveal">Reckon &middot; Azure FinOps health check &middot; ${esc(periodShort)}</p>
      <h1 class="slide__display reveal">${esc(customer)}</h1>
      <p class="cover__deck reveal">An invoice-grounded view of where the money goes, what is recoverable now, and what requires one more decision before it can be acted on.</p>
      <div class="cover__meta reveal">
        <span>Prepared for ${esc(customer)}</span>
        <span>&middot;</span>
        <span>${esc(periodLabel)}</span>
      </div>
    </div>
  </section>`;
}

function slideExecutiveSummary(
  result: AnalysisResult,
  customer: string,
  periodLabel: string,
  rowsCount: number,
): string {
  const annualWins = fmtMoney(result.immediateWinsMonthly * 12, result.invoice.displayCurrency);
  const actionable = result.findings.filter((f) => f.severity !== "investigate").length;
  return `
  <section class="slide slide--summary">
    ${tracker(0)}
    <p class="slide__eyebrow reveal">Executive summary</p>
    <h2 class="slide__action-title reveal">Roughly ${esc(annualWins)} of recurring Azure spend is recoverable, with most of it gated on a single licensing decision.</h2>
    <ol class="summary__points">
      <li class="summary__point reveal">
        <span class="summary__num">1</span>
        <div>
          <p class="summary__lead">${esc(annualWins)} per year is in scope</p>
          <p class="summary__body">Across ${actionable} actionable findings, derived from ${rowsCount.toLocaleString()} invoice rows totalling ${esc(fmtMoney(result.invoice.totalCost.amount, result.invoice.displayCurrency))} for the period.</p>
        </div>
      </li>
      <li class="summary__point reveal">
        <span class="summary__num">2</span>
        <div>
          <p class="summary__lead">The order of operations matters more than the size of any one win</p>
          <p class="summary__body">Hybrid Benefit first, commitments second, compute plans third. The sequencing reflects how the decisions compound, not the dollar value of any single line.</p>
        </div>
      </li>
      <li class="summary__point reveal">
        <span class="summary__num">3</span>
        <div>
          <p class="summary__lead">Most of the value is conditional, not confirmed</p>
          <p class="summary__body">Each conditional finding is gated on one discovery question. Answering them collapses each range to a point estimate and unlocks the corresponding saving.</p>
        </div>
      </li>
    </ol>
    ${sourceLine(periodLabel, rowsCount)}
  </section>`;
}

function slideSnapshot(
  result: AnalysisResult,
  periodLabel: string,
  rowsCount: number,
): string {
  const ccy = result.invoice.displayCurrency;
  const total = fmtMoney(result.invoice.totalCost.amount, ccy);
  const annualWins = fmtMoney(result.immediateWinsMonthly * 12, ccy);
  const monthlyWins = fmtMoney(result.immediateWinsMonthly, ccy);
  const actionable = result.findings.filter((f) => f.severity !== "investigate").length;
  const confirmed = result.findings.filter((f) => f.severity === "confirmed").length;
  const conditional = result.findings.filter((f) => f.severity === "conditional").length;
  return `
  <section class="slide slide--snapshot">
    ${tracker(0)}
    <p class="slide__eyebrow reveal">Estate snapshot</p>
    <h2 class="slide__action-title reveal">The estate runs at ${esc(total)} for the period, with ${esc(annualWins)} of that recoverable on an annualised basis.</h2>
    <div class="kpi-row">
      <div class="kpi reveal">
        <p class="kpi__label">Period invoice</p>
        <p class="kpi__value">${esc(total)}</p>
        <p class="kpi__foot">across ${rowsCount.toLocaleString()} rows</p>
      </div>
      <div class="kpi reveal">
        <p class="kpi__label">Recoverable, annualised</p>
        <p class="kpi__value kpi__value--accent">${esc(annualWins)}</p>
        <p class="kpi__foot">conservative floor estimate</p>
      </div>
      <div class="kpi reveal">
        <p class="kpi__label">Per-month opportunity</p>
        <p class="kpi__value">${esc(monthlyWins)}</p>
        <p class="kpi__foot">confirmed plus conditional floor</p>
      </div>
      <div class="kpi reveal">
        <p class="kpi__label">Findings on the table</p>
        <p class="kpi__value">${actionable}</p>
        <p class="kpi__foot">${confirmed} confirmed &middot; ${conditional} conditional</p>
      </div>
    </div>
    ${sourceLine(periodLabel, rowsCount, "Investigate-grade signals are excluded from recoverable totals.")}
  </section>`;
}

/* ---------------------------------------------------------------------- */
/* TechM-style landscape + top-services (pie chart) slides                */
/* ---------------------------------------------------------------------- */

const PIE_PALETTE = [
  "#1f4e6b", "#2f7a9c", "#4a9bbf", "#6fb8d6", "#8fcfe5",
  "#b9b272", "#d9a45a", "#c87b4a", "#a85440", "#7d3a35",
  "#9aa0aa",
];

interface ServiceSlice { name: string; cost: number; share: number; color: string; }

function topServicesSlices(rows: ReadonlyArray<{ serviceName: string; cost: number }>, n = 10): { slices: ServiceSlice[]; total: number } {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = r.serviceName || "(unspecified)";
    m.set(k, (m.get(k) ?? 0) + r.cost);
  }
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0) || 1;
  const head = sorted.slice(0, n);
  const tailSum = sorted.slice(n).reduce((s, [, v]) => s + v, 0);
  const slices: ServiceSlice[] = head.map(([name, cost], i) => ({
    name, cost, share: cost / total, color: PIE_PALETTE[i] ?? "#9aa0aa",
  }));
  if (tailSum > 0) {
    slices.push({ name: "Other", cost: tailSum, share: tailSum / total, color: PIE_PALETTE[10] });
  }
  return { slices, total };
}

function donutSvg(slices: ServiceSlice[], size = 320): string {
  const r = size / 2;
  const inner = r * 0.58;
  const cx = r;
  const cy = r;
  let acc = 0;
  const arcs = slices.map((s) => {
    const start = acc;
    const end = acc + s.share;
    acc = end;
    const a0 = start * 2 * Math.PI - Math.PI / 2;
    const a1 = end * 2 * Math.PI - Math.PI / 2;
    const large = s.share > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const xi1 = cx + inner * Math.cos(a1), yi1 = cy + inner * Math.sin(a1);
    const xi0 = cx + inner * Math.cos(a0), yi0 = cy + inner * Math.sin(a0);
    // Single slice (full circle) needs a different path.
    if (s.share >= 0.999) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${s.color}"/><circle cx="${cx}" cy="${cy}" r="${inner}" fill="var(--bg)"/>`;
    }
    const d = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${inner} ${inner} 0 ${large} 0 ${xi0} ${yi0} Z`;
    return `<path d="${d}" fill="${s.color}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${size} ${size}" width="100%" height="100%" role="img" aria-label="Top services pie chart" xmlns="http://www.w3.org/2000/svg">${arcs}</svg>`;
}

function slideEstateLandscape(
  result: AnalysisResult,
  periodLabel: string,
  rowsCount: number,
): string {
  const ccy = result.invoice.displayCurrency;
  const subs = new Set(result.invoice.rows.map((r) => r.subscriptionName).filter(Boolean));
  const monthly = result.invoice.totalCost.amount;
  const tagCard = result.landscape.find((c) => c.id === "landscape:tag-coverage");
  const orphanCard = result.landscape.find((c) => c.id === "landscape:orphan-region");
  const tagShare = tagCard?.metrics?.tagCoverageShare;
  const orphanShare = orphanCard?.metrics?.orphanShare;
  const orphanCost = orphanCard?.metrics?.orphanCost;
  const ruleBuckets = new Map<string, number>();
  for (const f of result.findings) {
    if (f.severity === "investigate") continue;
    const lbl = RULE_LABEL[f.jeannieRule] ?? "Optimisation";
    ruleBuckets.set(lbl, (ruleBuckets.get(lbl) ?? 0) + 1);
  }
  const areas = [...ruleBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const challenges: string[] = [];
  if (typeof tagShare === "number" && tagShare < 0.7) {
    challenges.push(`Governance: ${(tagShare * 100).toFixed(0)}% of spend is tagged — accountability is weak`);
  }
  if (typeof orphanShare === "number" && orphanShare > 0.005 && typeof orphanCost === "number") {
    challenges.push(`Orphan / unassigned region cost: ${fmtMoney(orphanCost, ccy)} (${(orphanShare * 100).toFixed(1)}%) — likely deleted-resource artefacts`);
  }
  const reservedRows = result.invoice.rows.filter((r) => /reservation|savings plan/i.test(r.meter ?? "")).length;
  if (reservedRows === 0) {
    challenges.push("No reservation or savings-plan signal observed in meter data — likely entire estate consumed at PAYG rates");
  }
  const investigateCount = result.findings.filter((f) => f.severity === "investigate").length;
  if (investigateCount > 0) {
    challenges.push(`${investigateCount} investigate-grade signals require utilisation or topology data not present on the invoice`);
  }
  if (challenges.length === 0) {
    challenges.push("No first-pass governance gaps surfaced from the invoice shape");
  }

  // Top-left "Current Azure Landscape" facts (TechM slide 1 mirror).
  const annualEst = monthly * 12;
  const regions = new Set(result.invoice.rows.map((r) => r.resourceLocation).filter(Boolean));
  const services = new Set(result.invoice.rows.map((r) => r.serviceName).filter(Boolean));
  const facts: string[] = [
    `Period spend ~ ${fmtMoney(monthly, ccy)} (${result.invoice.period.startDate.slice(0, 7)})`,
    `Annualised extrapolation ~ ${fmtMoney(annualEst, ccy)}`,
    `No. of subscriptions ~ ${subs.size}`,
    `Distinct services in use ~ ${services.size}`,
    `Distinct regions in use ~ ${regions.size}`,
    `Resources analysed ~ ${rowsCount.toLocaleString()} invoice rows`,
  ];

  return `
  <section class="slide slide--landscape">
    ${tracker(0)}
    <h2 class="landscape__title reveal">Customer pre-engagement Azure landscape</h2>
    <div class="landscape__layout">
      <aside class="landscape__rail landscape__rail--top reveal">Current Azure Landscape</aside>
      <section class="landscape__panel landscape__panel--top reveal">
        <ul class="landscape__list landscape__list--facts">
          ${facts.map((f) => `<li><span class="landscape__dot"></span><span>${esc(f)}</span></li>`).join("")}
        </ul>
      </section>
      <aside class="landscape__rail landscape__rail--bot reveal">Identified Areas of Improvement</aside>
      <section class="landscape__panel landscape__panel--bot reveal">
        <ul class="landscape__list">
          ${areas.map(([lbl, n]) => `<li><span class="landscape__dot"></span><span>${esc(lbl)}</span><span class="landscape__num">${n}</span></li>`).join("")}
        </ul>
      </section>
      <aside class="landscape__rail landscape__rail--right reveal">Challenges</aside>
      <section class="landscape__panel landscape__panel--right reveal">
        <ul class="landscape__list landscape__list--plain">
          ${challenges.map((c) => `<li><span class="landscape__bar"></span><span>${esc(c)}</span></li>`).join("")}
        </ul>
      </section>
    </div>
    <p class="landscape__note reveal">Note: inputs captured from the cost export only. Licensing model, tenant count, and tooling are discovery-only and need refining during initial engagement.</p>
    ${sourceLine(periodLabel, rowsCount)}
  </section>`;
}

function slideTopServices(
  result: AnalysisResult,
  periodLabel: string,
  rowsCount: number,
): string {
  const ccy = result.invoice.displayCurrency;
  const { slices, total } = topServicesSlices(result.invoice.rows, 10);
  const periodShort = result.invoice.period.startDate.slice(0, 7);
  const annualEst = total * 12;
  const rows = slices.map((s) => `
    <tr>
      <td><span class="legend__sw" style="background:${s.color}"></span>${esc(s.name)}</td>
      <td class="num">${esc(fmtMoney(s.cost, ccy))}</td>
      <td class="num">${(s.share * 100).toFixed(1)}%</td>
    </tr>`).join("");

  return `
  <section class="slide slide--services">
    ${tracker(0)}
    <p class="slide__eyebrow reveal">Current spend &middot; top services</p>
    <h2 class="slide__action-title reveal">Total ${esc(fmtMoney(total, ccy))} for ${esc(periodShort)} — extrapolating ~${esc(fmtMoney(annualEst, ccy))} annualised, concentrated in the top ${slices.length === 11 ? "10" : slices.length} services.</h2>
    <div class="services__body">
      <div class="services__chart reveal">${donutSvg(slices)}
        <div class="services__center">
          <p class="services__center-label">Monthly</p>
          <p class="services__center-value">${esc(fmtMoney(total, ccy))}</p>
        </div>
      </div>
      <div class="services__table-wrap reveal">
        <table class="services__table">
          <thead><tr><th>Service</th><th class="num">Cost</th><th class="num">Share</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
    ${sourceLine(periodLabel, rowsCount, "Annualised figure is a single-period extrapolation; multi-month trend requires sequential exports.")}
  </section>`;
}

function slideRightSizing(
  result: AnalysisResult,
  periodLabel: string,
  rowsCount: number,
): string {
  const ccy = result.invoice.displayCurrency;
  const rs = result.findings.filter((f) => f.jeannieRule === 7 && /^Right-size /.test(f.title));
  if (rs.length === 0) return "";

  const totalMonthly = rs.reduce((s, f) => s + (f.monthlySaving ?? 0), 0);
  const totalAnnual = totalMonthly * 12;
  const confirmed = rs.filter((f) => f.severity === "confirmed").length;
  const conditional = rs.filter((f) => f.severity === "conditional").length;

  const rows = rs.slice(0, 12).map((f) => {
    const m = f.title.match(/Right-size (\S+) — (\S+) → (\S+) \(cpu p95 (\S+)%, mem p95 (\S+)%\)/);
    if (!m) return "";
    const [, vm, fromSku, toSku, cpuP95, memP95] = m;
    const sevClass = f.severity === "confirmed" ? "rs__sev rs__sev--confirmed" : "rs__sev rs__sev--conditional";
    return `
      <tr>
        <td class="rs__vm">${esc(vm)}</td>
        <td class="rs__sku">${esc(fromSku)}</td>
        <td class="rs__sku">${esc(toSku)}</td>
        <td class="num">${cpuP95}%</td>
        <td class="num">${memP95}%</td>
        <td class="num"><strong>${esc(fmtMoney(f.monthlySaving ?? 0, ccy))}</strong>/mo</td>
        <td><span class="${sevClass}">${esc(f.severity)}</span></td>
      </tr>`;
  }).join("");

  return `
  <section class="slide slide--rightsizing">
    ${tracker(2)}
    <p class="slide__eyebrow reveal">Action map &middot; per-VM right-sizing (utilisation-backed)</p>
    <h2 class="slide__action-title reveal">Telemetry confirms ${esc(fmtMoney(totalAnnual, ccy))} per year of compute is recoverable across ${rs.length} VMs without changing workload behaviour.</h2>
    <div class="rs__chips reveal">
      <span class="rs__chip rs__chip--confirmed">${confirmed} confirmed</span>
      <span class="rs__chip rs__chip--conditional">${conditional} conditional</span>
      <span class="rs__chip">${esc(fmtMoney(totalMonthly, ccy))}/mo total</span>
    </div>
    <div class="rs__table-wrap reveal">
      <table class="rs__table">
        <thead><tr>
          <th>VM</th><th>Current SKU</th><th>Recommended</th>
          <th class="num">CPU p95</th><th class="num">Mem p95</th>
          <th class="num">Saving</th><th>Severity</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${sourceLine(periodLabel, rowsCount, "Joined from DMC Azure-mode scan (CPU/mem p95 over 90d) × invoice (compute charge per VM). Rule 7.")}
  </section>`;
}

function slidePerSliceActions(
  result: AnalysisResult,
  periodLabel: string,
  rowsCount: number,
): string {
  const ccy = result.invoice.displayCurrency;
  // resourceId → serviceName (cost-weighted dominant).
  const ridToService = new Map<string, string>();
  const ridServiceCost = new Map<string, Map<string, number>>();
  for (const r of result.invoice.rows) {
    if (!r.resourceId) continue;
    let svcMap = ridServiceCost.get(r.resourceId);
    if (!svcMap) { svcMap = new Map(); ridServiceCost.set(r.resourceId, svcMap); }
    svcMap.set(r.serviceName || "(unspecified)", (svcMap.get(r.serviceName || "(unspecified)") ?? 0) + r.cost);
  }
  for (const [rid, m] of ridServiceCost) {
    const winner = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (winner) ridToService.set(rid, winner[0]);
  }

  // Group actionable findings by dominant evidence service.
  const byService = new Map<string, Finding[]>();
  const orphans: Finding[] = [];
  for (const f of result.findings) {
    if (f.severity === "investigate") continue;
    const svcCounts = new Map<string, number>();
    for (const ev of f.evidence) {
      const svc = ridToService.get(ev.resourceId);
      if (svc) svcCounts.set(svc, (svcCounts.get(svc) ?? 0) + ev.cost);
    }
    const top = [...svcCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) { orphans.push(f); continue; }
    const arr = byService.get(top[0]) ?? [];
    arr.push(f);
    byService.set(top[0], arr);
  }

  // Sort services by total spend (same source as pie chart) and pick top 6 with findings.
  const { slices } = topServicesSlices(result.invoice.rows, 999);
  const rowsHtml = slices
    .filter((s) => byService.has(s.name))
    .slice(0, 6)
    .map((s) => {
      const fs = (byService.get(s.name) ?? [])
        .sort((a, b) => savingSortKey(b) - savingSortKey(a))
        .slice(0, 3);
      if (fs.length === 0) return "";
      const actions = fs.map((f) => `
        <li class="pslice__action">
          <span class="pslice__sev pslice__sev--${esc(f.severity)}">${esc(f.severity === "confirmed" ? "Confirmed" : "Conditional")}</span>
          <span class="pslice__title">${esc(f.title)}</span>
          <span class="pslice__value">${esc(annualised(f, ccy))}</span>
        </li>`).join("");
      return `
        <article class="pslice__row reveal">
          <header class="pslice__head">
            <span class="pslice__sw" style="background:${s.color}"></span>
            <div>
              <p class="pslice__name">${esc(s.name)}</p>
              <p class="pslice__meta">${esc(fmtMoney(s.cost, ccy))} · ${(s.share * 100).toFixed(1)}% of spend · ${fs.length} action${fs.length === 1 ? "" : "s"}</p>
            </div>
          </header>
          <ol class="pslice__actions">${actions}</ol>
        </article>`;
    })
    .filter(Boolean)
    .join("");

  return `
  <section class="slide slide--pslice">
    ${tracker(0)}
    <p class="slide__eyebrow reveal">Per-slice action map</p>
    <h2 class="slide__action-title reveal">For each slice of the pie, the highest-value actions tied to that service.</h2>
    <div class="pslice__grid">${rowsHtml || `<p class="pslice__empty">No service-attributable actionable findings in this period.</p>`}</div>
    ${sourceLine(periodLabel, rowsCount, "Findings mapped to service via dominant evidence; investigate-grade items excluded.")}
  </section>`;
}

function slideFramework(
  result: AnalysisResult,
  periodLabel: string,
  rowsCount: number,
): string {
  const invoked = new Set(result.findings.map((f) => f.jeannieRule));
  const cells = PRINCIPLES.map((p) => {
    const cls = invoked.has(p.n) ? " framework__cell--invoked" : "";
    return `
        <div class="framework__cell${cls} reveal">
          <p class="framework__num">Rule ${String(p.n).padStart(2, "0")}</p>
          <p class="framework__name">${esc(p.title)}</p>
          <p class="framework__sub">${esc(p.sub)}</p>
        </div>`;
  }).join("");
  return `
  <section class="slide slide--framework">
    ${tracker(1)}
    <p class="slide__eyebrow reveal">Method &middot; the FinOps framework</p>
    <h2 class="slide__action-title reveal">Every finding is a controlled application of one of ten optimisation principles.</h2>
    <p class="framework__lede reveal">The framework decides the order of operations and the threshold for what counts as a confirmed saving. It also fixes the discovery question that has to be answered before any conditional recommendation is acted on. Principles invoked by findings in this report are highlighted.</p>
    <div class="framework__grid">${cells}</div>
    ${sourceLine(periodLabel, rowsCount, `${invoked.size} of ${FRAMEWORK_RULES.length} principles invoked this period.`)}
  </section>`;
}

function slideApproach(groups: ReturnType<typeof splitByLever>): string {
  const card = (n: string, name: string, why: string, count: number) => `
      <article class="approach__card reveal">
        <p class="approach__num">${n}</p>
        <h3 class="approach__name">${name}</h3>
        <p class="approach__why">${why}</p>
        <p class="approach__count">${count} finding${count === 1 ? "" : "s"} surfaced</p>
      </article>`;
  return `
  <section class="slide slide--approach">
    ${tracker(1)}
    <p class="slide__eyebrow reveal">Approach</p>
    <h2 class="slide__action-title reveal">Three optimisation levers, pulled in a fixed order, deliver the bulk of the recoverable value.</h2>
    <div class="approach__grid">
      ${card("01", "Hybrid Benefit", "Apply existing Microsoft licences against running Azure VMs to remove the bundled rental fee.", groups.hybrid)}
      ${card("02", "Commitments", "Lock the steady-state baseline at a discount; exchange the commitment dollar-for-dollar if the workload changes.", groups.commitments)}
      ${card("03", "Compute plans", "Three-year compute plan over App Service, Functions, and Container Apps where utilisation is predictable.", groups.computePlans)}
    </div>
    <p class="approach__rationale reveal">The order is deliberate. Hybrid Benefit changes the unit price of the underlying compute, so it should be applied before commitments are sized. Commitments then lock the new, lower unit price. Compute plans cover the remainder where reservations do not apply.</p>
  </section>`;
}

function slideFinding(
  f: Finding,
  customer: string,
  ctx: VoiceContext,
  idx: number,
  total: number,
  periodLabel: string,
  rowsCount: number,
): string {
  const ccy = ctx.currency;
  const tag = f.severity === "confirmed" ? "Confirmed action" : "Conditional action";
  const lever = (RULE_LABEL[f.jeannieRule] ?? "Optimisation").toLowerCase();
  const narrative = voiceFor("customer", f.narrative.customer, f, ctx);
  const annual = annualised(f, ccy);
  const monthly = monthlyLabel(f, ccy);
  return `
  <section class="slide slide--finding">
    ${tracker(2)}
    <div class="finding__header">
      <p class="slide__eyebrow reveal">Action ${idx + 1} of ${total} &middot; ${esc(tag)} &middot; Rule ${String(f.jeannieRule).padStart(2, "0")} &middot; ${esc(principleName(f.jeannieRule))}</p>
      <h2 class="slide__action-title reveal">${esc(actionHeadline(f, ccy))}</h2>
      <p class="finding__dek reveal">${esc(f.title)}</p>
    </div>
    <div class="finding__body">
      <div class="finding__hero reveal">
        <p class="finding__hero-label">Annualised value</p>
        <p class="finding__hero-value">${esc(annual)}</p>
        <p class="finding__hero-period">monthly equivalent: ${esc(monthly)}</p>
      </div>
      <div class="finding__narrative reveal">
        <p class="finding__lead">What this means for ${esc(customer)}</p>
        <p class="finding__text">${esc(narrative)}</p>
      </div>
    </div>
    ${sourceLine(periodLabel, rowsCount, `Implements Rule ${f.jeannieRule} of 10 · ${lever}.`)}
  </section>`;
}

function slideSequencing(
  top: Finding[],
  ctx: VoiceContext,
): string {
  const items = top
    .map(
      (f, i) => `
        <li class="sequence__item reveal">
          <span class="sequence__num">${String(i + 1).padStart(2, "0")}</span>
          <div>
            <p class="sequence__action">${esc(actionHeadline(f, ctx.currency))}</p>
            <p class="sequence__detail">${esc(f.title)}</p>
          </div>
        </li>`,
    )
    .join("");
  return `
  <section class="slide slide--sequence">
    ${tracker(2)}
    <p class="slide__eyebrow reveal">Recommended sequencing</p>
    <h2 class="slide__action-title reveal">The first six actions, taken in order, deliver the bulk of the annualised opportunity.</h2>
    <ol class="sequence">${items}</ol>
  </section>`;
}

function slideLimits(periodLabel: string, rowsCount: number): string {
  return `
  <section class="slide slide--limits">
    ${tracker(3)}
    <p class="slide__eyebrow reveal">What the invoice cannot tell us</p>
    <h2 class="slide__action-title reveal">An invoice-only view answers where the money goes; a follow-up assessment is required to confirm whether each workload is earning it.</h2>
    <div class="limits__grid">
      <div class="limits__cell reveal">
        <p class="limits__num">A</p>
        <h3 class="limits__head">Utilisation is invisible</h3>
        <p class="limits__body">CPU, memory, disk I/O, and time-of-day patterns are not on the invoice. Right-sizing decisions therefore require a separate utilisation assessment.</p>
      </div>
      <div class="limits__cell reveal">
        <p class="limits__num">B</p>
        <h3 class="limits__head">Topology is invisible</h3>
        <p class="limits__body">Network paths, gateway redundancy, and private-endpoint sprawl require a topology review, not a cost line.</p>
      </div>
      <div class="limits__cell reveal">
        <p class="limits__num">C</p>
        <h3 class="limits__head">Intent is invisible</h3>
        <p class="limits__body">A 250-resource-group estate could be deliberate isolation or ungoverned growth. The invoice cannot distinguish the two.</p>
      </div>
    </div>
    ${sourceLine(periodLabel, rowsCount, "Investigate-grade findings in this report require this follow-up before they can be acted on.")}
  </section>`;
}

function slideNextSteps(customer: string, periodLabel: string): string {
  return `
  <section class="slide slide--next">
    ${tracker(3)}
    <p class="slide__eyebrow reveal">Next steps</p>
    <h2 class="slide__action-title reveal">Three near-term steps move the recoverable opportunity from the page to the invoice.</h2>
    <div class="next__grid">
      <article class="next__card reveal">
        <p class="next__step">Step 1 &middot; this week</p>
        <h3 class="next__title">Confirm the licensing position</h3>
        <p class="next__body">Verify Software Assurance entitlements and SQL Server editions in deployment, then activate Hybrid Benefit on the qualifying workloads identified in this report.</p>
      </article>
      <article class="next__card reveal">
        <p class="next__step">Step 2 &middot; within four weeks</p>
        <h3 class="next__title">Right-size and rationalise commitments</h3>
        <p class="next__body">Resolve reservation overflow and mixed-generation coverage, then sequence new commitments at the post-Hybrid-Benefit unit price.</p>
      </article>
      <article class="next__card reveal">
        <p class="next__step">Step 3 &middot; following month</p>
        <h3 class="next__title">Commission the utilisation assessment</h3>
        <p class="next__body">Schedule the follow-up assessment that closes the visibility gaps listed above and converts investigate-grade signals into actionable findings.</p>
      </article>
    </div>
    <p class="next__close reveal">Prepared for ${esc(customer)} &middot; ${esc(periodLabel)}</p>
  </section>`;
}

/* ---------------------------------------------------------------------- */
/* Page shell                                                             */
/* ---------------------------------------------------------------------- */

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${SLIDE_CSS}</style>
</head>
<body>
<div class="deck">
${body}
</div>
${SLIDE_JS}
</body>
</html>`;
}

const SLIDE_CSS = `
:root {
  --font-display: 'Source Serif 4', Georgia, serif;
  --font-body: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
  --bg: #ffffff;
  --bg-soft: #f7f7f5;
  --bg-mute: #efeee9;
  --text: #0c1320;
  --text-soft: #2a3142;
  --text-dim: #6b7180;
  --rule: #e2e0d8;
  --rule-strong: #c8c4b4;
  --accent: #1f4e6b;
  --accent-soft: #e6eef3;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1320;
    --bg-soft: #131a29;
    --bg-mute: #1a2236;
    --text: #f0f1f3;
    --text-soft: #c8ccd4;
    --text-dim: #8a91a0;
    --rule: rgba(240, 240, 240, 0.08);
    --rule-strong: rgba(240, 240, 240, 0.14);
    --accent: #6ea3c2;
    --accent-soft: rgba(110, 163, 194, 0.10);
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--font-body); color: var(--text); background: var(--bg); overflow: hidden; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
.deck { height: 100dvh; overflow-y: auto; scroll-snap-type: y mandatory; scroll-behavior: smooth; }
.slide { height: 100dvh; scroll-snap-align: start; overflow: hidden; position: relative; padding: clamp(64px, 7vh, 96px) clamp(56px, 8vw, 120px) clamp(56px, 6vh, 80px); display: flex; flex-direction: column; isolation: isolate; opacity: 0; transform: translateY(28px); transition: opacity 0.55s cubic-bezier(0.16, 1, 0.3, 1), transform 0.55s cubic-bezier(0.16, 1, 0.3, 1); background: var(--bg); }
.slide.visible { opacity: 1; transform: none; }
.slide .reveal { opacity: 0; transform: translateY(14px); transition: opacity 0.45s cubic-bezier(0.16, 1, 0.3, 1), transform 0.45s cubic-bezier(0.16, 1, 0.3, 1); }
.slide.visible .reveal { opacity: 1; transform: none; }
.slide.visible .reveal:nth-child(1) { transition-delay: 0.06s; }
.slide.visible .reveal:nth-child(2) { transition-delay: 0.14s; }
.slide.visible .reveal:nth-child(3) { transition-delay: 0.22s; }
.slide.visible .reveal:nth-child(4) { transition-delay: 0.30s; }
.slide.visible .reveal:nth-child(5) { transition-delay: 0.38s; }
.slide.visible .reveal:nth-child(6) { transition-delay: 0.46s; }

@media (prefers-reduced-motion: reduce) {
  .slide, .slide .reveal { opacity: 1 !important; transform: none !important; transition: none !important; }
}

.tracker { position: absolute; top: clamp(20px, 3vh, 36px); left: clamp(56px, 8vw, 120px); right: clamp(56px, 8vw, 120px); display: flex; gap: clamp(10px, 1.5vw, 18px); border-bottom: 1px solid var(--rule); padding-bottom: clamp(8px, 1vh, 14px); }
.tracker__item { font-family: var(--font-mono); font-size: clamp(10px, 1.1vw, 12px); text-transform: uppercase; letter-spacing: 1.4px; color: var(--text-dim); }
.tracker__item--active { color: var(--accent); font-weight: 600; }

.source-line { position: absolute; bottom: clamp(20px, 3vh, 32px); left: clamp(56px, 8vw, 120px); right: clamp(56px, 8vw, 120px); font-family: var(--font-mono); font-size: clamp(10px, 1vw, 11px); color: var(--text-dim); border-top: 1px solid var(--rule); padding-top: 10px; letter-spacing: 0.3px; }

.slide__display { font-family: var(--font-display); font-size: clamp(40px, 6.4vw, 84px); font-weight: 500; letter-spacing: -1px; line-height: 1.04; text-wrap: balance; color: var(--text); }
.slide__action-title { font-family: var(--font-display); font-size: clamp(22px, 3vw, 38px); font-weight: 500; letter-spacing: -0.2px; line-height: 1.22; text-wrap: balance; color: var(--text); max-width: 22em; }
.slide__eyebrow { font-family: var(--font-mono); font-size: clamp(10px, 1.1vw, 12px); font-weight: 600; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: clamp(14px, 2vh, 22px); }

.slide--cover { justify-content: center; padding: clamp(72px, 10vh, 120px) clamp(56px, 8vw, 120px); }
.cover__rule { width: 96px; height: 4px; background: var(--accent); margin-bottom: clamp(28px, 4vh, 56px); }
.cover__inner { max-width: 880px; }
.cover__deck { font-family: var(--font-display); font-size: clamp(18px, 2.2vw, 26px); line-height: 1.45; color: var(--text-soft); margin-top: clamp(24px, 3.5vh, 40px); max-width: 36em; }
.cover__meta { display: flex; gap: 12px; flex-wrap: wrap; font-family: var(--font-mono); font-size: clamp(11px, 1.2vw, 13px); color: var(--text-dim); text-transform: uppercase; letter-spacing: 1.4px; margin-top: clamp(48px, 6vh, 84px); }

.slide--summary { padding-top: clamp(72px, 9vh, 120px); justify-content: flex-start; }
.summary__points { list-style: none; margin-top: clamp(28px, 4vh, 48px); display: grid; gap: clamp(18px, 2.4vh, 32px); max-width: 1080px; }
.summary__point { display: grid; grid-template-columns: clamp(36px, 5vw, 60px) 1fr; gap: clamp(16px, 2vw, 28px); align-items: start; }
.summary__num { font-family: var(--font-display); font-size: clamp(28px, 3.5vw, 44px); font-weight: 500; color: var(--accent); line-height: 1; padding-top: 4px; }
.summary__lead { font-family: var(--font-display); font-size: clamp(18px, 2.2vw, 26px); font-weight: 600; color: var(--text); margin-bottom: 6px; line-height: 1.25; }
.summary__body { font-size: clamp(14px, 1.5vw, 18px); color: var(--text-soft); line-height: 1.55; max-width: 38em; }

.slide--snapshot { padding-top: clamp(72px, 9vh, 120px); }
.kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: clamp(20px, 2.5vw, 36px); margin-top: clamp(36px, 5vh, 64px); }
.kpi { border-top: 2px solid var(--rule-strong); padding-top: clamp(14px, 2vh, 22px); }
.kpi__label { font-family: var(--font-mono); font-size: clamp(10px, 1.1vw, 12px); text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim); margin-bottom: clamp(10px, 1.4vh, 16px); }
.kpi__value { font-family: var(--font-display); font-size: clamp(28px, 3.6vw, 48px); font-weight: 500; letter-spacing: -1px; line-height: 1.05; color: var(--text); font-variant-numeric: tabular-nums; }
.kpi__value--accent { color: var(--accent); }
.kpi__foot { font-size: clamp(12px, 1.3vw, 14px); color: var(--text-dim); margin-top: 8px; line-height: 1.45; }

.slide--framework { padding-top: clamp(72px, 9vh, 120px); }
.framework__lede { margin-top: clamp(8px, 1.4vh, 14px); max-width: 50em; font-size: clamp(13px, 1.4vw, 16px); color: var(--text-soft); line-height: 1.55; }
.framework__grid { display: grid; grid-template-columns: repeat(5, 1fr); grid-auto-rows: 1fr; gap: clamp(10px, 1.4vw, 18px); margin-top: clamp(20px, 3vh, 36px); flex: 1; min-height: 0; }
.framework__cell { background: var(--bg-soft); border: 1px solid var(--rule); border-top: 2px solid var(--rule-strong); padding: clamp(12px, 2vh, 20px) clamp(10px, 1.2vw, 16px); display: flex; flex-direction: column; gap: 4px; opacity: 0.55; transition: opacity 0.3s, border-color 0.3s, background 0.3s; }
.framework__cell--invoked { border-top-color: var(--accent); background: var(--bg); opacity: 1; }
.framework__num { font-family: var(--font-mono); font-size: clamp(9px, 1vw, 11px); color: var(--accent); font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; }
.framework__name { font-family: var(--font-display); font-size: clamp(13px, 1.5vw, 18px); color: var(--text); font-weight: 500; line-height: 1.2; }
.framework__sub { font-size: clamp(11px, 1.1vw, 13px); color: var(--text-dim); line-height: 1.4; margin-top: auto; }

.slide--approach { padding-top: clamp(72px, 9vh, 120px); }
.approach__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: clamp(20px, 2.4vw, 32px); margin-top: clamp(32px, 4.5vh, 56px); }
.approach__card { background: var(--bg-soft); border: 1px solid var(--rule); border-top: 3px solid var(--accent); padding: clamp(20px, 3vh, 32px); display: flex; flex-direction: column; gap: 8px; }
.approach__num { font-family: var(--font-mono); font-size: clamp(11px, 1.1vw, 13px); color: var(--accent); font-weight: 600; letter-spacing: 1.5px; }
.approach__name { font-family: var(--font-display); font-size: clamp(20px, 2.5vw, 32px); font-weight: 500; color: var(--text); line-height: 1.15; }
.approach__why { font-size: clamp(13px, 1.4vw, 16px); color: var(--text-soft); line-height: 1.55; flex: 1; }
.approach__count { font-family: var(--font-mono); font-size: clamp(10px, 1.1vw, 12px); text-transform: uppercase; letter-spacing: 1.5px; color: var(--accent); border-top: 1px solid var(--rule); padding-top: 12px; }
.approach__rationale { margin-top: clamp(20px, 3vh, 32px); max-width: 60em; font-size: clamp(13px, 1.4vw, 16px); color: var(--text-soft); line-height: 1.6; border-left: 2px solid var(--rule-strong); padding-left: 16px; }

.slide--finding { padding-top: clamp(72px, 9vh, 120px); }
.finding__header { max-width: 32em; }
.finding__dek { font-family: var(--font-mono); font-size: clamp(12px, 1.3vw, 14px); color: var(--text-dim); margin-top: clamp(10px, 1.4vh, 16px); letter-spacing: 0.3px; }
.finding__body { display: grid; grid-template-columns: 5fr 6fr; gap: clamp(28px, 4vw, 60px); align-items: start; margin-top: clamp(28px, 4vh, 48px); }
.finding__hero { background: var(--accent-soft); border-left: 4px solid var(--accent); padding: clamp(20px, 3vh, 36px) clamp(20px, 2.5vw, 32px); }
.finding__hero-label { font-family: var(--font-mono); font-size: clamp(10px, 1.1vw, 12px); text-transform: uppercase; letter-spacing: 1.5px; color: var(--accent); font-weight: 600; }
.finding__hero-value { font-family: var(--font-display); font-size: clamp(36px, 5.4vw, 72px); font-weight: 500; letter-spacing: -1.5px; line-height: 1; color: var(--accent); margin: clamp(10px, 1.6vh, 18px) 0 clamp(8px, 1.2vh, 14px); font-variant-numeric: tabular-nums; }
.finding__hero-period { font-family: var(--font-mono); font-size: clamp(11px, 1.2vw, 13px); color: var(--text-dim); letter-spacing: 0.3px; }
.finding__lead { font-family: var(--font-mono); font-size: clamp(10px, 1.1vw, 12px); text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim); font-weight: 600; margin-bottom: clamp(8px, 1.2vh, 14px); }
.finding__text { font-size: clamp(14px, 1.6vw, 19px); color: var(--text); line-height: 1.55; max-width: 36em; }

.slide--sequence { padding-top: clamp(72px, 9vh, 120px); }
.sequence { list-style: none; margin-top: clamp(28px, 4vh, 48px); display: grid; gap: clamp(14px, 2vh, 22px); max-width: 1100px; }
.sequence__item { display: grid; grid-template-columns: clamp(48px, 6vw, 72px) 1fr; gap: clamp(16px, 2vw, 28px); border-top: 1px solid var(--rule); padding-top: clamp(12px, 1.6vh, 18px); }
.sequence__num { font-family: var(--font-display); font-size: clamp(20px, 2.5vw, 30px); color: var(--accent); font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
.sequence__action { font-size: clamp(14px, 1.6vw, 18px); font-weight: 500; color: var(--text); line-height: 1.4; }
.sequence__detail { font-family: var(--font-mono); font-size: clamp(11px, 1.2vw, 13px); color: var(--text-dim); margin-top: 4px; letter-spacing: 0.2px; }

.slide--limits { padding-top: clamp(72px, 9vh, 120px); }
.limits__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: clamp(24px, 2.8vw, 40px); margin-top: clamp(32px, 4.5vh, 56px); }
.limits__cell { border-top: 2px solid var(--rule-strong); padding-top: clamp(14px, 2vh, 22px); }
.limits__num { font-family: var(--font-display); font-size: clamp(20px, 2.4vw, 28px); color: var(--accent); font-weight: 600; margin-bottom: clamp(10px, 1.4vh, 16px); }
.limits__head { font-family: var(--font-display); font-size: clamp(18px, 2.2vw, 26px); color: var(--text); font-weight: 500; line-height: 1.2; margin-bottom: clamp(8px, 1.2vh, 14px); }
.limits__body { font-size: clamp(13px, 1.4vw, 16px); color: var(--text-soft); line-height: 1.6; }

.slide--landscape { padding-top: clamp(56px, 7vh, 88px); }
.landscape__title { font-family: var(--font-display); font-size: clamp(24px, 2.6vw, 32px); font-weight: 600; color: var(--bg); background: var(--accent); padding: clamp(10px, 1.4vh, 16px) clamp(18px, 2vw, 28px); margin: 0 0 clamp(16px, 2vh, 24px); letter-spacing: -0.2px; }
.landscape__layout { display: grid; grid-template-columns: clamp(36px, 4vw, 56px) 1.4fr clamp(36px, 4vw, 56px) 1fr; grid-template-rows: auto auto; gap: clamp(8px, 1.2vh, 14px) clamp(10px, 1.2vw, 16px); flex: 1; min-height: 0; }
.landscape__rail { writing-mode: vertical-rl; transform: rotate(180deg); background: var(--accent); color: var(--bg); font-family: var(--font-mono); font-size: clamp(11px, 1.15vw, 13px); font-weight: 600; text-transform: uppercase; letter-spacing: 1.6px; padding: clamp(14px, 1.8vh, 20px) clamp(8px, 0.8vw, 12px); display: flex; align-items: center; justify-content: center; }
.landscape__rail--top { grid-column: 1; grid-row: 1; }
.landscape__rail--bot { grid-column: 1; grid-row: 2; }
.landscape__rail--right { grid-column: 3; grid-row: 1 / span 2; }
.landscape__panel { background: var(--bg-soft); border: 1px solid var(--rule); border-left: 3px solid var(--accent); padding: clamp(14px, 2vh, 22px) clamp(16px, 1.8vw, 24px); overflow: auto; }
.landscape__panel--top { grid-column: 2; grid-row: 1; }
.landscape__panel--bot { grid-column: 2; grid-row: 2; }
.landscape__panel--right { grid-column: 4; grid-row: 1 / span 2; }
.landscape__list { list-style: none; display: flex; flex-direction: column; gap: clamp(7px, 1vh, 11px); }
.landscape__list li { display: grid; grid-template-columns: 14px 1fr auto; gap: 12px; align-items: center; font-size: clamp(12px, 1.3vw, 15px); color: var(--text); line-height: 1.4; }
.landscape__list--plain li { grid-template-columns: 4px 1fr; align-items: start; }
.landscape__list--plain li > span:last-child { color: var(--text-soft); }
.landscape__list--facts li { font-family: var(--font-mono); font-size: clamp(11px, 1.2vw, 14px); color: var(--text); }
.landscape__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); display: inline-block; }
.landscape__bar { width: 3px; height: 100%; min-height: 16px; background: var(--accent); display: inline-block; align-self: stretch; }
.landscape__num { font-family: var(--font-mono); font-size: clamp(11px, 1.2vw, 13px); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.landscape__note { margin-top: clamp(12px, 1.8vh, 18px); font-size: clamp(11px, 1.2vw, 13px); color: var(--text-dim); font-style: italic; max-width: 60em; }

.slide--services { padding-top: clamp(72px, 9vh, 120px); }
.services__body { display: grid; grid-template-columns: minmax(260px, 1fr) 1.4fr; gap: clamp(28px, 4vw, 56px); margin-top: clamp(24px, 3.5vh, 40px); flex: 1; min-height: 0; align-items: center; }
.services__chart { position: relative; aspect-ratio: 1 / 1; max-width: clamp(260px, 32vh, 380px); margin: 0 auto; }
.services__center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
.services__center-label { font-family: var(--font-mono); font-size: clamp(10px, 1.1vw, 12px); text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim); }
.services__center-value { font-family: var(--font-display); font-size: clamp(18px, 2vw, 24px); font-weight: 600; color: var(--text); margin-top: 4px; font-variant-numeric: tabular-nums; }
.services__table-wrap { overflow: auto; max-height: 60vh; }
.services__table { width: 100%; border-collapse: collapse; font-size: clamp(12px, 1.3vw, 14px); }
.services__table th { text-align: left; font-family: var(--font-mono); font-size: clamp(10px, 1.1vw, 12px); text-transform: uppercase; letter-spacing: 1.4px; color: var(--text-dim); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--rule-strong); }
.services__table td { padding: 9px 10px; border-bottom: 1px solid var(--rule); color: var(--text); line-height: 1.35; }
.services__table .num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--font-mono); color: var(--text-soft); }
.legend__sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 10px; vertical-align: middle; }

.slide--rightsizing { padding-top: clamp(72px, 9vh, 120px); }
.rs__chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: clamp(14px, 2vh, 20px); }
.rs__chip { font-family: var(--font-mono); font-size: clamp(11px, 1.15vw, 13px); padding: 6px 12px; border: 1px solid var(--rule-strong); border-radius: 999px; color: var(--text-soft); letter-spacing: 0.4px; }
.rs__chip--confirmed { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.rs__chip--conditional { color: var(--text); }
.rs__table-wrap { margin-top: clamp(18px, 2.6vh, 28px); flex: 1; min-height: 0; overflow: auto; }
.rs__table { width: 100%; border-collapse: collapse; font-size: clamp(12px, 1.3vw, 14px); }
.rs__table th { text-align: left; font-family: var(--font-mono); font-size: clamp(10px, 1.05vw, 12px); text-transform: uppercase; letter-spacing: 1.4px; color: var(--text-dim); font-weight: 600; padding: 10px 10px; border-bottom: 2px solid var(--rule-strong); position: sticky; top: 0; background: var(--bg); }
.rs__table td { padding: 10px 10px; border-bottom: 1px solid var(--rule); color: var(--text); line-height: 1.35; vertical-align: top; }
.rs__table .num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
.rs__vm { font-family: var(--font-mono); font-weight: 600; }
.rs__sku { font-family: var(--font-mono); font-size: clamp(11px, 1.2vw, 13px); color: var(--text-soft); }
.rs__sev { font-family: var(--font-mono); font-size: clamp(10px, 1.05vw, 12px); text-transform: uppercase; letter-spacing: 1px; padding: 3px 8px; border-radius: 3px; }
.rs__sev--confirmed { background: var(--accent); color: var(--bg); font-weight: 600; }
.rs__sev--conditional { border: 1px solid var(--rule-strong); color: var(--text-dim); }

.slide--pslice { padding-top: clamp(72px, 9vh, 120px); }
.pslice__grid { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(16px, 2vh, 24px) clamp(24px, 3vw, 40px); margin-top: clamp(20px, 3vh, 32px); align-content: start; flex: 1; min-height: 0; overflow: auto; }
.pslice__row { display: flex; flex-direction: column; gap: clamp(8px, 1.2vh, 12px); border-top: 2px solid var(--rule-strong); padding-top: clamp(10px, 1.4vh, 14px); }
.pslice__head { display: grid; grid-template-columns: 14px 1fr; gap: 12px; align-items: start; }
.pslice__sw { width: 12px; height: 12px; border-radius: 3px; margin-top: 4px; }
.pslice__name { font-family: var(--font-display); font-size: clamp(15px, 1.7vw, 19px); font-weight: 600; color: var(--text); line-height: 1.2; }
.pslice__meta { font-family: var(--font-mono); font-size: clamp(10px, 1.05vw, 12px); color: var(--text-dim); margin-top: 3px; letter-spacing: 0.3px; }
.pslice__actions { list-style: none; display: flex; flex-direction: column; gap: 4px; padding-left: 26px; }
.pslice__action { display: grid; grid-template-columns: 84px 1fr auto; gap: 10px; align-items: baseline; font-size: clamp(11px, 1.2vw, 13px); color: var(--text); line-height: 1.4; padding: 4px 0; border-bottom: 1px dotted var(--rule); }
.pslice__sev { font-family: var(--font-mono); font-size: clamp(9px, 1vw, 11px); text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }
.pslice__sev--confirmed { color: var(--accent); }
.pslice__sev--conditional { color: var(--text-dim); }
.pslice__title { color: var(--text-soft); }
.pslice__value { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); font-weight: 500; white-space: nowrap; }
.pslice__empty { color: var(--text-dim); font-style: italic; }

.slide--next { padding-top: clamp(72px, 9vh, 120px); }
.next__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: clamp(20px, 2.4vw, 32px); margin-top: clamp(32px, 4.5vh, 56px); }
.next__card { background: var(--bg-soft); border: 1px solid var(--rule); padding: clamp(22px, 3vh, 32px); display: flex; flex-direction: column; gap: 10px; }
.next__step { font-family: var(--font-mono); font-size: clamp(10px, 1.1vw, 12px); text-transform: uppercase; letter-spacing: 1.5px; color: var(--accent); font-weight: 600; }
.next__title { font-family: var(--font-display); font-size: clamp(18px, 2.2vw, 26px); color: var(--text); font-weight: 500; line-height: 1.2; }
.next__body { font-size: clamp(13px, 1.4vw, 16px); color: var(--text-soft); line-height: 1.55; }
.next__close { margin-top: auto; padding-top: clamp(28px, 4vh, 48px); font-family: var(--font-mono); font-size: clamp(11px, 1.2vw, 13px); color: var(--text-dim); text-transform: uppercase; letter-spacing: 1.4px; }

.deck-progress { position: fixed; top: 0; left: 0; height: 2px; background: var(--accent); z-index: 100; transition: width 0.3s ease; pointer-events: none; }
.deck-counter { position: fixed; bottom: clamp(16px, 2vh, 24px); right: clamp(20px, 3vw, 36px); font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); z-index: 100; font-variant-numeric: tabular-nums; letter-spacing: 1px; }
.deck-hints { position: fixed; bottom: clamp(16px, 2vh, 24px); left: clamp(20px, 3vw, 36px); font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); opacity: 0.45; z-index: 100; transition: opacity 0.5s ease; letter-spacing: 1.2px; text-transform: uppercase; }
.deck-hints.faded { opacity: 0; pointer-events: none; }

@media (max-width: 1080px) {
  .approach__grid, .next__grid, .limits__grid, .pslice__grid { grid-template-columns: repeat(2, 1fr); }
  .services__body { grid-template-columns: 1fr; }
  .landscape__layout { grid-template-columns: clamp(32px, 4vw, 48px) 1fr; grid-template-rows: auto auto auto; }
  .landscape__rail--top { grid-column: 1; grid-row: 1; }
  .landscape__panel--top { grid-column: 2; grid-row: 1; }
  .landscape__rail--bot { grid-column: 1; grid-row: 2; }
  .landscape__panel--bot { grid-column: 2; grid-row: 2; }
  .landscape__rail--right { grid-column: 1; grid-row: 3; }
  .landscape__panel--right { grid-column: 2; grid-row: 3; }
  .kpi-row { grid-template-columns: repeat(2, 1fr); gap: clamp(20px, 3vw, 32px) clamp(24px, 4vw, 48px); }
  .finding__body { grid-template-columns: 1fr; }
  .framework__grid { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 720px) {
  .approach__grid, .next__grid, .limits__grid, .kpi-row, .framework__grid, .pslice__grid { grid-template-columns: 1fr; }
  .summary__point { grid-template-columns: 36px 1fr; }
}
@media (max-height: 700px) { .slide { padding: clamp(48px, 6vh, 72px) clamp(40px, 6vw, 80px); } }
`;

const SLIDE_JS = `
<script>
function autoFit() {
  document.querySelectorAll('.kpi__value, .finding__hero-value').forEach(function (el) {
    if (el.scrollWidth > el.clientWidth) {
      var s = el.clientWidth / el.scrollWidth;
      el.style.transform = 'scale(' + s + ')';
      el.style.transformOrigin = 'left top';
    }
  });
}

function SlideEngine() {
  this.deck = document.querySelector('.deck');
  this.slides = [].slice.call(document.querySelectorAll('.slide'));
  this.current = 0;
  this.total = this.slides.length;
  this.buildChrome();
  this.bindEvents();
  this.observe();
  this.update();
}
SlideEngine.prototype.buildChrome = function () {
  var bar = document.createElement('div'); bar.className = 'deck-progress';
  document.body.appendChild(bar); this.bar = bar;
  var ctr = document.createElement('div'); ctr.className = 'deck-counter';
  document.body.appendChild(ctr); this.counter = ctr;
  var hints = document.createElement('div'); hints.className = 'deck-hints';
  hints.textContent = '\\u2190 \\u2192 or scroll to navigate';
  document.body.appendChild(hints); this.hints = hints;
  this.hintTimer = setTimeout(function () { hints.classList.add('faded'); }, 4000);
};
SlideEngine.prototype.bindEvents = function () {
  var self = this;
  document.addEventListener('keydown', function (e) {
    if (e.target.closest('input, textarea, [contenteditable]')) return;
    if (['ArrowDown', 'ArrowRight', ' ', 'PageDown'].indexOf(e.key) > -1) { e.preventDefault(); self.next(); }
    else if (['ArrowUp', 'ArrowLeft', 'PageUp'].indexOf(e.key) > -1) { e.preventDefault(); self.prev(); }
    else if (e.key === 'Home') { e.preventDefault(); self.goTo(0); }
    else if (e.key === 'End')  { e.preventDefault(); self.goTo(self.total - 1); }
    self.fadeHints();
  });
  var tY;
  this.deck.addEventListener('touchstart', function (e) { tY = e.touches[0].clientY; }, { passive: true });
  this.deck.addEventListener('touchend', function (e) {
    var dy = tY - e.changedTouches[0].clientY;
    if (Math.abs(dy) > 50) { dy > 0 ? self.next() : self.prev(); }
  });
};
SlideEngine.prototype.observe = function () {
  var self = this;
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        self.current = self.slides.indexOf(entry.target);
        self.update();
      }
    });
  }, { threshold: 0.5 });
  this.slides.forEach(function (s) { obs.observe(s); });
};
SlideEngine.prototype.goTo = function (i) {
  this.slides[Math.max(0, Math.min(i, this.total - 1))].scrollIntoView({ behavior: 'smooth' });
};
SlideEngine.prototype.next = function () { if (this.current < this.total - 1) this.goTo(this.current + 1); };
SlideEngine.prototype.prev = function () { if (this.current > 0) this.goTo(this.current - 1); };
SlideEngine.prototype.update = function () {
  this.bar.style.width = ((this.current + 1) / this.total * 100) + '%';
  this.counter.textContent = String(this.current + 1).padStart(2, '0') + ' / ' + String(this.total).padStart(2, '0');
};
SlideEngine.prototype.fadeHints = function () { clearTimeout(this.hintTimer); this.hints.classList.add('faded'); };

document.addEventListener('DOMContentLoaded', function () {
  autoFit();
  new SlideEngine();
});
</script>`;

/* ---------------------------------------------------------------------- */
/* Public API                                                             */
/* ---------------------------------------------------------------------- */

export function renderSlides(
  result: AnalysisResult,
  options: RenderSlidesOptions = {},
): SlidesOutput {
  const customer = options.customerNameOverride?.trim() || result.invoice.customerName;
  const periodLabel = `${result.invoice.period.startDate} → ${result.invoice.period.endDate}`;
  const periodShort = result.invoice.period.startDate.slice(0, 7);
  const rowsCount = result.invoice.rows.length;
  const ctx: VoiceContext = {
    currency: result.invoice.displayCurrency,
    hoursInPeriod: result.invoice.period.hoursInPeriod,
  };

  const top = selectTopFindings(result.findings, 6);
  const groups = splitByLever(result.findings);

  const body =
    slideCover(customer, periodShort, periodLabel) +
    slideExecutiveSummary(result, customer, periodLabel, rowsCount) +
    slideSnapshot(result, periodLabel, rowsCount) +
    slideEstateLandscape(result, periodLabel, rowsCount) +
    slideTopServices(result, periodLabel, rowsCount) +
    slidePerSliceActions(result, periodLabel, rowsCount) +
    slideFramework(result, periodLabel, rowsCount) +
    slideApproach(groups) +
    top.map((f, i) => slideFinding(f, customer, ctx, i, top.length, periodLabel, rowsCount)).join("") +
    slideRightSizing(result, periodLabel, rowsCount) +
    slideSequencing(top, ctx) +
    slideLimits(periodLabel, rowsCount) +
    slideNextSteps(customer, periodLabel);

  const title = `${customer} — Reckon · Azure FinOps health check · ${periodShort}`;
  const filename = `${sanitiseFilenamePart(customer)}_${sanitiseFilenamePart(periodShort)}_finops_slides.html`;
  return { html: shell(title, body), filename };
}
