/**
 * Audience-aware HTML renderer for the FinOps health-check report.
 *
 * Three audiences (per prompt) — visibility is mostly handled by CSS
 * classes (.for-customer / .for-consultant / .for-informational), so the
 * markup is generated once and the audience just selects what shows.
 *
 *   Customer       — warm, no jargon, no acronyms, no evidence tables,
 *                    no internal terms, "license commitment" not "RI",
 *                    investigate findings rendered as "worth a conversation".
 *   Consultant     — technical, dense, SKU/meter/RG visible, evidence open,
 *                    framework rule numbers cited.
 *   Informational  — most verbose, includes the Jeannie quote inline,
 *                    rate-table provenance, validation visible, alternative
 *                    readings.
 *
 * The renderer never silently drops content that another audience needs —
 * it tags it with the right `.for-*` class. That keeps a single HTML file
 * portable and lets future versions add an audience-toggle without re-running
 * the engine.
 */

import type { AnalysisResult } from "../engine/index";
import type { Finding, ValidationReport } from "../types";
import { FRAMEWORK_RULES, getFrameworkRule } from "../engine/framework";
import { RATES_CAPTURED_DATE, RATES_SOURCE } from "../engine/rates";
import { renderShell } from "./template";
import { esc, escAttr, fmtMoney, fmtMoneyRange } from "./escape";
import { voiceFor, scrubFramework, type VoiceContext } from "./voice";

export type Audience = "customer" | "consultant" | "informational";

export interface RenderHtmlOptions {
  audience: Audience;
  /** Optional override for the customer name shown in the header. */
  customerNameOverride?: string;
}

export interface HtmlOutput {
  html: string;
  filename: string;
}

export function renderHtml(result: AnalysisResult, options: RenderHtmlOptions): HtmlOutput {
  const { invoice, findings, validation, immediateWinsMonthly } = result;
  const customer = options.customerNameOverride ?? invoice.customerName;
  const periodLabel = `${invoice.period.startDate} → ${invoice.period.endDate}`;
  const periodSlug = invoice.period.startDate.slice(0, 7);

  const ctx: VoiceContext = {
    currency: invoice.displayCurrency,
    hoursInPeriod: invoice.period.hoursInPeriod,
  };
  const body = [
    renderHero(customer, invoice, immediateWinsMonthly, options.audience, findings),
    renderApproach(options.audience, findings),
    renderSavingsLadder(findings, invoice.displayCurrency),
    renderFindingsByCategory(findings, invoice.displayCurrency, ctx),
    renderLimits(options.audience),
    renderValidationAppendix(validation, options.audience),
    renderFooter(),
  ].join("\n");

  const html = renderShell({
    customerName: customer,
    periodLabel,
    audience: options.audience,
    body: `<main>${body}</main>`,
  });

  return {
    html,
    filename: `${sanitiseFilenamePart(customer)}_${sanitiseFilenamePart(periodSlug)}_finops_${options.audience}.html`,
  };
}

/* ---------------------------------------------------------------------- */
/* Sections                                                               */
/* ---------------------------------------------------------------------- */

function renderHero(
  customer: string,
  invoice: AnalysisResult["invoice"],
  immediateWinsMonthly: number,
  audience: "customer" | "consultant" | "informational",
  findings: Finding[],
): string {
  const annual = immediateWinsMonthly * 12;
  const annualStr = fmtMoney(annual, invoice.displayCurrency);
  const monthlyStr = fmtMoney(immediateWinsMonthly, invoice.displayCurrency);
  const actionable = findings.filter((f) => f.severity !== "investigate").length;

  // Audience-shaped action title — McKinsey-style "so-what" headline.
  // Customer: warm, sales-led, no engine internals.
  // Consultant: precise, recommendation-led.
  // Informational: analytical, with method context.
  const actionTitle =
    audience === "customer"
      ? `Around ${annualStr} of recurring spend is recoverable from this estate, most of it gated on one licensing decision.`
      : audience === "consultant"
        ? `${annualStr} annualised opportunity across ${actionable} actionable findings, presented in lever order: Hybrid Benefit, commitments, compute plans.`
        : `Engine surfaced ${findings.length} findings across 10 optimisation rules; ${actionable} are actionable and contribute to the headline ${annualStr}/yr at the conservative floor.`;

  const eyebrowText =
    audience === "informational"
      ? "Azure FinOps health check · informational rendering"
      : audience === "consultant"
        ? "Azure FinOps health check · consultant working draft"
        : "Azure FinOps health check";

  const qualText =
    audience === "customer"
      ? `${monthlyStr} per month at the conservative floor. The invisible-but-likely items — sprawl, dormant resources, network duplication — are kept out of this number.`
      : audience === "consultant"
        ? `${monthlyStr}/mo confirmed plus conditional-floor. Investigate-grade signals are excluded from the headline per the severity discipline of the framework.`
        : `${monthlyStr}/mo from confirmed (deletable from invoice alone) plus conditional-floor (range floor where one discovery question collapses to a point estimate). Investigate-grade signals are excluded by validator rule, never aggregated.`;

  return `
<section class="hero">
  <div class="eyebrow">${esc(eyebrowText)}</div>
  <h1>${esc(customer)}</h1>
  <p class="hero-action-title">${esc(actionTitle)}</p>
  <div class="meta">
    <span class="mono">${esc(invoice.period.startDate)} → ${esc(invoice.period.endDate)}</span>
    <span class="mono">${invoice.rows.length.toLocaleString()} rows</span>
    <span class="mono">Total invoice ${esc(fmtMoney(invoice.totalCost.amount, invoice.displayCurrency))}</span>
  </div>
  <div class="headline">
    <div class="label">Recoverable opportunity · annualised</div>
    <div class="number mono">${esc(annualStr)}</div>
    <div class="qual">${esc(qualText)}</div>
  </div>
</section>`;
}

/**
 * The framework section. Audience-shaped — the principles are the engine's
 * constitution, and showing them up front lets each finding cite a principle
 * without explanation later in the document.
 */
function renderApproach(audience: Audience, findings: Finding[]): string {
  const usedPrinciples = new Set(findings.map((f) => f.jeannieRule));

  if (audience === "customer") {
    return `
<section class="section">
  <div class="eyebrow">How this review is built</div>
  <h2>A ten-principle FinOps framework, applied to your invoice</h2>
  <p>This review uses a ten-principle FinOps health-check framework. The principles set the order in which to pull pricing levers and the rules for what counts as a confirmed saving versus a saving still gated on a question. Every finding cites a principle and every dollar reconciles to an invoice line.</p>
  <p>The order matters. Hybrid Benefit goes first because the licence discount changes the unit price of the underlying compute, so commitments and compute plans should be sized after that. The framework is the reason this report reads in lever order rather than dollar order.</p>
</section>`;
  }

  if (audience === "consultant") {
    const items = FRAMEWORK_RULES.map(
      (r) =>
        `<li${usedPrinciples.has(r.number) ? ' class="invoked"' : ""}><span class="num">Rule ${r.number}.</span> ${esc(r.title)}</li>`,
    ).join("");
    return `
<section class="section">
  <div class="eyebrow">Method · ${usedPrinciples.size} of ${FRAMEWORK_RULES.length} principles invoked this period</div>
  <h2>Ten optimisation principles, applied in fixed order</h2>
  <p>The framework sets the lever order and the severity contract. Discovery questions are mandatory wherever action depends on configuration knowledge the invoice cannot show. Every finding below declares which principle it implements; the validator rejects any finding that violates the contract.</p>
  <ol class="principles-list">${items}</ol>
  <p class="principles-foot">Principles in <strong>bold</strong> are invoked by at least one finding in this report. The remainder describe behaviour the framework defines but that this estate did not trigger.</p>
</section>`;
  }

  // Informational: full rule statement per principle, plus engine application.
  const cards = FRAMEWORK_RULES.map((r) => {
    const sourceText = scrubFramework((r.statement || r.derivedGuidance).trim());
    const sourceLabel = r.derived ? "engineering-derived" : "framework rule";
    return `
    <article class="principle">
      <header>
        <span class="num">Rule ${r.number}</span>
        <h3>${esc(r.title)}</h3>
      </header>
      <p class="quote">${esc(sourceText)}</p>
      <p class="guidance"><strong>Engine application:</strong> ${esc(scrubFramework(r.guidance))}</p>
      <p class="provenance">Source: ${esc(sourceLabel)}.</p>
    </article>`;
  }).join("");

  return `
<section class="section">
  <div class="eyebrow">Method · framework lineage</div>
  <h2>Ten optimisation principles, applied to invoice rows</h2>
  <p>Each principle below is either a canonical framework rule statement or an engineering interpretation marked as derived. The validator enforces several principles as runtime invariants and rejects any finding that violates them. ${usedPrinciples.size} of ${FRAMEWORK_RULES.length} principles were invoked by findings in this report.</p>
  <div class="principles">${cards}</div>
</section>`;
}

function renderSavingsLadder(findings: Finding[], currency: string): string {
  const confirmed = findings
    .filter((f) => f.severity === "confirmed")
    .reduce((s, f) => s + (f.monthlySaving ?? 0), 0);
  const condLow = findings
    .filter((f) => f.severity === "conditional")
    .reduce((s, f) => s + (f.monthlySavingRange?.[0] ?? f.monthlySaving ?? 0), 0);
  const condHigh = findings
    .filter((f) => f.severity === "conditional")
    .reduce((s, f) => s + (f.monthlySavingRange?.[1] ?? f.monthlySaving ?? 0), 0);
  const investigateCount = findings.filter((f) => f.severity === "investigate").length;

  return `
<section class="section">
  <div class="eyebrow">Savings ladder · monthly</div>
  <h2>From confirmed floor to investigative ceiling</h2>
  <p>Three rungs, ordered by what the invoice can already prove. The first rung is recoverable now. The second rung needs one discovery question per finding before it can be claimed. The third rung is observation only and is excluded from the headline by design.</p>
  <div class="ladder">
    <div class="rung confirmed">
      <span class="label">Confirmed · do tomorrow</span>
      <span class="value">${esc(fmtMoney(confirmed, currency))}</span>
    </div>
    <div class="rung conditional">
      <span class="label">Conditional · pending one question each</span>
      <span class="value">${esc(fmtMoney(condLow, currency))} → ${esc(fmtMoney(condHigh, currency))}</span>
    </div>
    <div class="rung investigate">
      <span class="label">Investigate · ${investigateCount} signal${investigateCount === 1 ? "" : "s"}</span>
      <span class="value">excluded from totals by design</span>
    </div>
  </div>
</section>`;
}

function renderFindingsByCategory(findings: Finding[], currency: string, ctx: VoiceContext): string {
  const groups: Record<Finding["category"], Finding[]> = { lever: [], runtime: [], anomaly: [] };
  for (const f of findings) groups[f.category].push(f);
  const titles: Record<Finding["category"], string> = {
    lever: "Pricing levers deliver the bulk of the recoverable value.",
    runtime: "Runtime profile, derived from invoice rows, shows where time and money are actually spent.",
    anomaly: "Operational signals point to sprawl, mismatched tiers, and resources that have outlived their purpose.",
  };
  const eyebrows: Record<Finding["category"], string> = {
    lever: "Section 01 of 03 · Pricing levers",
    runtime: "Section 02 of 03 · Runtime profile",
    anomaly: "Section 03 of 03 · Operational signals",
  };

  return (["lever", "runtime", "anomaly"] as const)
    .map((cat) => {
      if (groups[cat].length === 0) return "";
      return `
<section class="section">
  <div class="eyebrow">${eyebrows[cat]}</div>
  <h2>${esc(titles[cat])}</h2>
  ${groups[cat].map((f) => renderFinding(f, currency, ctx)).join("\n")}
</section>`;
    })
    .join("\n");
}

function renderFinding(f: Finding, currency: string, ctx: VoiceContext): string {
  const sevClass = `sev-${f.severity}`;
  const savingHtml = renderSavingValue(f, currency);
  const evidenceHtml = renderEvidence(f, currency);
  const frame = getFrameworkRule(f.jeannieRule);

  // Voice-shape each narrative for its audience. The CSS still hides the
  // non-matching audience blocks, but each one is now humanised + audience-shaped.
  const customerText = voiceFor("customer", f.narrative.customer, f, ctx);
  const consultantText = voiceFor("consultant", f.narrative.consultant, f, ctx);
  const informationalText = voiceFor("informational", f.narrative.informational, f, ctx);

  return `
<article class="finding ${sevClass}">
  <header>
    <h3 class="title">
      ${esc(f.title)}
      <span class="pill ${sevClass}">${esc(f.severity)}</span>
      <span class="pill frame">Rule ${f.jeannieRule}</span>
    </h3>
    <span class="saving ${f.monthlySavingRange ? "range" : ""}">${savingHtml}</span>
  </header>

  <div class="body for-customer">
    <p>${esc(customerText)}</p>
  </div>
  <div class="body for-consultant">
    <p>${esc(consultantText)}</p>
  </div>
  <div class="body for-informational">
    <p>${esc(informationalText)}</p>
    <div class="frame-callout">
      ${esc(scrubFramework(frame.statement || frame.derivedGuidance))}
      <span class="src">${frame.derived
        ? "Engineering-derived guidance"
        : "Framework rule"}</span>
    </div>
  </div>

  ${renderDiscoveryQuestions(f)}
  ${evidenceHtml}
</article>`;
}

function renderSavingValue(f: Finding, currency: string): string {
  if (f.monthlySaving !== null) return `${esc(fmtMoney(f.monthlySaving, currency))}/mo`;
  if (f.monthlySavingRange) return `${esc(fmtMoneyRange(f.monthlySavingRange, currency))}/mo`;
  return `<span style="color: var(--bone-mute);">observation</span>`;
}

function renderDiscoveryQuestions(f: Finding): string {
  if (f.discoveryQuestions.length === 0) return "";
  return `
  <div class="discovery">
    <div class="label">Confirmations needed before action</div>
    <ul>${f.discoveryQuestions.map((q) => `<li>${esc(scrubFramework(q))}</li>`).join("")}</ul>
  </div>`;
}

function renderEvidence(f: Finding, currency: string): string {
  if (f.evidence.length === 0) return "";
  return `
  <details class="evidence">
    <summary>${f.evidence.length} evidence row${f.evidence.length === 1 ? "" : "s"}</summary>
    <table>
      <thead><tr>
        <th>Resource</th>
        <th>Meter</th>
        <th class="num">Cost</th>
        <th>Reason</th>
      </tr></thead>
      <tbody>
        ${f.evidence
          .slice(0, 50)
          .map(
            (e) => `<tr>
          <td>${esc(shorten(e.resourceId))}</td>
          <td>${esc(e.meter)}</td>
          <td class="num">${esc(fmtMoney(e.cost, currency))}</td>
          <td>${esc(e.reason)}</td>
        </tr>`
          )
          .join("")}
        ${f.evidence.length > 50
          ? `<tr><td colspan="4" style="color: var(--bone-mute);">… ${f.evidence.length - 50} more rows omitted from preview</td></tr>`
          : ""}
      </tbody>
    </table>
  </details>`;
}

function renderLimits(audience: Audience): string {
  const ruleCite =
    audience === "customer"
      ? ""
      : audience === "consultant"
        ? '<p class="rule-cite">This section is required by Rule 7 of the framework: the invoice tells you where money goes, not whether each workload is earning it.</p>'
        : '<p class="rule-cite">This section is the application of Rule 7 (the invoice tells you where money goes, not whether it earns) and Rule 10 (severity discipline). Investigate-grade signals listed in the report above are excluded from any aggregated saving total by validator rule. The follow-up assessment is the mechanism by which those signals become actionable findings.</p>';
  return `
<section class="limits">
  <h2>An invoice answers where the money goes; a follow-up assessment is needed to confirm whether each workload is earning it.</h2>
  <p>Every finding above is grounded in an invoice line. The invoice cannot, by itself, answer whether the workload behind that line is being used efficiently. Three categories of evidence remain out of scope for an invoice-only review.</p>
  <ul>
    <li>Utilisation. CPU, memory, and disk I/O are not on the invoice. Right-sizing decisions require 30 days of Azure Monitor data or a dedicated assessment.</li>
    <li>Topology. Network paths, gateway redundancy, and private-endpoint sprawl require an architecture review, not a cost line.</li>
    <li>Intent. A 250-resource-group estate could be deliberate isolation or ungoverned growth. The invoice cannot distinguish the two.</li>
  </ul>
  <p><strong>Recommended next engagement: a follow-up utilisation and topology assessment.</strong> The invoice is the cheapest place to start. The assessment is where right-sizing and consolidation recommendations become defensible.</p>
  ${ruleCite}
</section>`;
}

function renderValidationAppendix(v: ValidationReport, audience: Audience): string {
  const ruleNote =
    audience === "informational"
      ? `<p class="rule-cite" style="margin-top: 12px;">Validation enforces five framework principles at runtime: Rule 2 (no SQL Hybrid Benefit point estimates, range required), Rule 8 (annualised equals monthly × 12 exactly, no rounding drift), Rule 9 (discovery questions mandatory unless severity = confirmed and effort = low), Rule 10 (investigate-grade findings excluded from aggregated totals), and an evidence-reconciliation check (every dollar in a finding maps to invoice rows, unless the finding is a declared range estimate).</p>`
      : "";
  if (v.issues.length === 0) {
    return `
<section class="appendix">
  <details>
    <summary>Validation · all checks passed</summary>
    <p style="margin-top: 12px;">Every finding's evidence reconciles. Every required discovery question is present. Every annualised figure equals monthly × 12. No SQL Hybrid Benefit point estimates. No <code>investigate</code> findings have been aggregated into the headline.</p>
    ${ruleNote}
  </details>
</section>`;
  }
  const errCount = v.issues.filter((i) => i.level === "error").length;
  const warnCount = v.issues.filter((i) => i.level === "warning").length;
  return `
<section class="appendix">
  <details ${errCount > 0 ? "open" : ""}>
    <summary>Validation · ${errCount} error${errCount === 1 ? "" : "s"}, ${warnCount} warning${warnCount === 1 ? "" : "s"}</summary>
    <div class="issues">
      ${v.issues
        .map(
          (i) => `<div class="row ${i.level}"><span class="code">${esc(i.code)}</span> ${esc(i.message)}</div>`
        )
        .join("")}
    </div>
    ${ruleNote}
  </details>
</section>`;
}

function renderFooter(): string {
  return `
<footer>
  <div>Prepared with Reckon · Altra Cloud · ${FRAMEWORK_RULES.length} optimisation rules applied.</div>
  <div class="gen">Source: Azure cost analysis export. Hourly rate provenance: ${esc(RATES_SOURCE)}, captured ${esc(RATES_CAPTURED_DATE)}.</div>
</footer>`;
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

function shorten(rid: string): string {
  // Keep it readable: drop subscriptions/x/resourceGroups/y/providers/z
  // prefix when the resourceId is long, keep last 3 path segments.
  if (!rid.includes("/")) return rid;
  const parts = rid.split("/");
  if (parts.length <= 4) return rid;
  return ".../" + parts.slice(-3).join("/");
}

function sanitiseFilenamePart(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
