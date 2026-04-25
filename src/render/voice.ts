/**
 * Render-time voice filters.
 *
 * Each rule emits three narratives at write-time. This layer does two things
 * before they reach the page:
 *
 *   1. Humanise — strip the AI tells (em-dashes, copula avoidance, weasel
 *      participles, sycophantic hedging) that the rules tend to accrete.
 *      Rules: Wikipedia "Signs of AI writing" (humanizer skill).
 *
 *   2. Audience-shape — translate jargon for the customer voice, sharpen
 *      action verbs for the consultant voice, and append exhaustive context
 *      (framework quote, evidence math, alternative readings) for the
 *      informational voice.
 *
 * We deliberately do this in render rather than in the rules: the rules
 * stay machine-honest and short, and editorial voice lives close to the
 * page where it can be tuned without touching evaluation logic.
 */

import type { Finding } from "../types";
import { getFrameworkRule } from "../engine/framework";
import { fmtMoney, fmtMoneyRange } from "./escape";

export type Audience = "customer" | "consultant" | "informational";

export interface VoiceContext {
  currency: string;
  hoursInPeriod: number;
}

/* ---------------------------------------------------------------------- */
/* Humanizer pass — applies to all audiences                              */
/* ---------------------------------------------------------------------- */

/**
 * Strip personal attribution from the framework. The engine internally
 * still calls things "Jeannie Rule N" because that is the source-of-truth
 * lineage in code, but every customer-facing string says "FinOps Rule N"
 * (or just drops the citation for the customer audience).
 */
export function scrubFramework(s: string): string {
  let out = s;
  out = out.replace(/\bJeannie Rule\s+(\d+)\b/g, "FinOps Rule $1");
  out = out.replace(/\bJeannie's framework\b/gi, "the FinOps framework");
  out = out.replace(/\bPer Jeannie\b/gi, "Per the framework");
  out = out.replace(/\bJeannie\b/g, "the framework");
  return out;
}

/**
 * Pattern-based replacements for the most common AI tells in our rules.
 * Order matters — em-dash handling first so the comma rules below can
 * normalise the resulting double-spaces and stranded clauses.
 */
function humanise(s: string): string {
  let out = scrubFramework(s);

  // Em-dash → comma. We use em-dashes far too often; humans use them rarely.
  // Keep the en-dash for numeric ranges (handled separately).
  out = out.replace(/\s+—\s+/g, ", ");
  out = out.replace(/—/g, ", ");

  // Copula avoidance. "stands as / serves as / acts as / functions as" → "is".
  out = out.replace(/\b(stands|serves|acts|functions)\s+as\b/gi, "is");

  // Weasel participle endings: ", showcasing/highlighting/emphasising/reflecting
  // / underscoring/contributing X". Drop the participle clause; the sentence
  // before it is usually the actual claim.
  out = out.replace(
    /,\s*(showcasing|highlighting|emphasising|emphasizing|reflecting|underscoring|contributing\s+to|fostering|cultivating|symbolising|symbolizing)\b[^.]*?\./gi,
    ".",
  );

  // Sycophantic openers.
  out = out.replace(/^(Great question[!.]?\s*|Certainly[!.]?\s*|Of course[!.]?\s*)/i, "");

  // Filler phrases.
  out = out.replace(/\bin order to\b/gi, "to");
  out = out.replace(/\bat this point in time\b/gi, "now");
  out = out.replace(/\bdue to the fact that\b/gi, "because");
  out = out.replace(/\bit is important to note that\b/gi, "");

  // Excessive hedging.
  out = out.replace(/\bcould potentially possibly\b/gi, "could");
  out = out.replace(/\bcould potentially\b/gi, "could");
  out = out.replace(/\bmight possibly\b/gi, "might");

  // Curly quotes → straight.
  out = out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // Tidy double spaces and stranded punctuation from substitutions.
  out = out.replace(/\s+,/g, ",");
  out = out.replace(/,\s*,/g, ",");
  out = out.replace(/\s{2,}/g, " ");
  out = out.replace(/\.\s*\./g, ".");

  return out.trim();
}

/* ---------------------------------------------------------------------- */
/* Customer pass — strip jargon, lead with money, soften technical terms  */
/* ---------------------------------------------------------------------- */

/**
 * Substitution table for the customer voice. The rules use FinOps shorthand
 * because it's accurate and dense; the customer wants plain English.
 *
 * Order: longest match first within each category, otherwise greedy
 * substitution can mangle ("RGs" before "RG" before resource group).
 */
const CUSTOMER_SUBSTITUTIONS: Array<[RegExp, string]> = [
  // Hybrid Benefit / licensing
  [/\bHybrid Benefit\b/g, "the licence-discount programme"],
  [/\bAHB for SQL Server\b/gi, "the SQL Server licence discount"],
  [/\bAHB\b/g, "the licence discount"],
  [/\bSoftware Assurance\b/g, "active Microsoft licences"],
  [/\bSA cores?\b/gi, "spare licence capacity"],
  [/\bSA\b(?=\s+(?:core|entitlement|cover))/g, "the licence agreement"],
  [/\bBYOL\b/g, "bring-your-own-licence"],
  // Reservations & Savings Plans
  [/\bRI(?:s)?\b/g, "licence commitment"],
  [/\bReservation Exchange\b/g, "swapping the commitment"],
  [/\b3-year reservation\b/gi, "a three-year commitment"],
  // Longer match first — otherwise "compute Savings Plan" double-rewrites.
  [/\bcompute Savings Plan\b/gi, "compute commitment plan"],
  [/\bSavings Plan\b/g, "commitment plan"],
  // Azure-isms
  [/\bPAYG\b/g, "pay-as-you-go"],
  [/\bRGs?\b/g, "environment"],
  [/\bresource group\b/gi, "environment"],
  [/\bvCores?\b/g, "CPU cores"],
  [/\bSKUs?\b/g, "machine sizes"],
  [/\bSSD variant\b/gi, "the disk type"],
  [/\bspinning disk\b/gi, "older disk type"],
  [/\bv\d\b/g, "machine generation"],
  // Internal terms forbidden by the spec
  [/\bDMC scan\b/gi, "a follow-up assessment"],
  [/\bAzure Monitor\b/g, "Azure's monitoring"],
  // SQL editions
  [/\bSQL Server (Standard|Enterprise|Web)\b/g, "SQL Server"],
  // Make tone direct, not technical
  [/\bFinOps Rule \d+\b/g, "the framework"],
  [/\bRule \d+\b/g, "the framework"],
];

function customerVoice(s: string): string {
  let out = s;
  for (const [re, sub] of CUSTOMER_SUBSTITUTIONS) out = out.replace(re, sub);
  // Soften "investigate" framing (per spec: "worth a conversation").
  out = out.replace(/\binvestigate\b/gi, "worth a conversation");
  out = out.replace(/\banomaly\b/gi, "something to look at");
  return out;
}

/* ---------------------------------------------------------------------- */
/* Consultant pass — leave jargon, kill fluff                             */
/* ---------------------------------------------------------------------- */

/**
 * Consultant voice — clinical, analytical, technical. We sharpen the opening
 * with a stance-led marker so the prose reads like a recommendation rather
 * than a paragraph of context.
 */
function consultantVoice(s: string): string {
  return s; // technical idiom retained; the leading marker is added in voiceFor().
}

/* ---------------------------------------------------------------------- */
/* Informational pass — exhaustive expansion                              */
/* ---------------------------------------------------------------------- */

/**
 * The informational audience is the engine showing its working. We expand
 * the narrative with: framework lineage + canonical rule statement, the
 * exact evidence reconciliation, the discovery questions inline, and (for
 * ranges) the formula behind the floor/ceiling.
 */
function informationalVoice(s: string, f: Finding, ctx: VoiceContext): string {
  const frame = getFrameworkRule(f.jeannieRule);
  const parts: string[] = [`Engine analysis: ${s}`];

  // Framework lineage with canonical rule statement scrubbed of personal
  // names — the lineage matters, the rule statement is recorded in the
  // appendix.
  const statement = (frame.statement || frame.derivedGuidance || "").trim();
  if (statement) {
    parts.push(`Framework lineage: FinOps Rule ${f.jeannieRule} of 10. Rule: ${scrubFramework(statement)}`);
  }

  // Evidence reconciliation.
  if (f.evidence.length > 0) {
    const total = f.evidence.reduce((s2, e) => s2 + e.cost, 0);
    parts.push(
      `Evidence reconciles to ${fmtMoney(total, ctx.currency)} across ${f.evidence.length} invoice row${
        f.evidence.length === 1 ? "" : "s"
      }.`,
    );
  }

  // Saving math (only if a range is present, where the floor/ceiling logic matters).
  if (f.monthlySavingRange) {
    parts.push(
      `Saving is presented as a range (${fmtMoneyRange(f.monthlySavingRange, ctx.currency)} monthly) because the floor and ceiling depend on a single discovery question. The point estimate is deliberately withheld.`,
    );
  }

  // Severity-driven aggregation rule.
  if (f.severity === "investigate") {
    parts.push(
      `Severity is investigate, so this finding is excluded from any aggregated saving total (the validator enforces this).`,
    );
  } else if (f.severity === "confirmed") {
    parts.push(
      `Severity is confirmed: the saving is demonstrable from the invoice alone and contributes to the immediate-wins headline.`,
    );
  } else {
    parts.push(
      `Severity is conditional: a single discovery question collapses the range to a point estimate.`,
    );
  }

  // Discovery questions inline (informational shows them with the prose).
  if (f.discoveryQuestions.length > 0) {
    parts.push(
      `Discovery questions in scope: ${f.discoveryQuestions.map((q) => `"${q}"`).join(" ")}`,
    );
  }

  return parts.join(" ");
}

/* ---------------------------------------------------------------------- */
/* Public API                                                             */
/* ---------------------------------------------------------------------- */

/**
 * Sales-led prefix for customer voice — sets the action stance up front,
 * so the customer reads recommendation-first instead of context-first.
 */
function customerStance(f: Finding): string {
  if (f.severity === "confirmed") return "Worth doing now.";
  if (f.severity === "conditional") return "Behind one decision.";
  return "Worth a conversation.";
}

/** Recommendation-led prefix for consultant voice. */
function consultantStance(f: Finding): string {
  if (f.severity === "confirmed") return "Recommendation:";
  if (f.severity === "conditional") return "Recommendation pending one confirmation:";
  return "Observation, action pending discovery:";
}

export function voiceFor(
  audience: Audience,
  text: string,
  finding: Finding,
  ctx: VoiceContext,
): string {
  const humanised = humanise(text);
  if (audience === "customer") {
    return humanise(`${customerStance(finding)} ${customerVoice(humanised)}`);
  }
  if (audience === "consultant") {
    return `${consultantStance(finding)} ${consultantVoice(humanised)}`;
  }
  return humanise(informationalVoice(humanised, finding, ctx));
}

/** Exposed for testing. */
export const __test = { humanise, customerVoice, informationalVoice };
