/**
 * JEANNIE'S FINOPS FRAMEWORK — the source-of-truth rules.
 *
 * These ten rules come from a recorded conversation with Jeannie, an
 * ex-Microsoft Global Black Belt who led reservations and FinOps work
 * across the top 200 Azure estates. They are not flavour text. They define:
 *
 *   1. The order of operations for every report (Hybrid Benefit → Reservations
 *      → Savings Plans, regardless of $ value — Rule 1).
 *   2. The reasoning style of every finding (severity discipline — Rule 10).
 *   3. The mandatory humanity layer (discovery questions — Rule 9).
 *
 * Every rule file under `src/engine/rules/` MUST declare which framework rule
 * it implements via the `framework: { rule, quote }` field on its Rule
 * export. `validateFindings` enforces this lineage and the rule-specific
 * invariants (no SQL HB point estimates, no aggregation of `investigate`
 * findings, mandatory discovery questions).
 *
 * STATEMENT PROVENANCE
 * --------------------
 *   - `statement` is the canonical rule statement — a clean, declarative
 *     paraphrase of Jeannie's source guidance, written for inclusion in
 *     customer/consultant reports. The `transcriptLines` field gives the
 *     line range in `transcript.txt` so an engineering reviewer can verify
 *     the paraphrase is faithful to the source.
 *   - `derivedGuidance` is engineering interpretation — used when a rule
 *     captures Jeannie's overall posture (e.g. severity discipline) without
 *     a single source line that crystallises it. Marked explicitly so no
 *     one mistakes engineering choice for source guidance.
 *
 * Treat this file as a constitution. If a future rule file cannot honestly
 * cite one of these ten rules, the right move is usually to question the
 * rule, not to add an eleventh.
 */

export interface FrameworkRule {
  /** 1..10. Order is meaningful — see Rule 1. */
  number: number;
  title: string;
  /**
   * Canonical rule statement — declarative paraphrase of the source
   * guidance, suitable for direct inclusion in a customer/consultant
   * report. Empty string when the rule is engineering-derived (see
   * `derivedGuidance`).
   */
  statement: string;
  /**
   * Line range in transcript.txt that backs `statement`. Engineer-only
   * audit trail — never rendered to the customer/consultant. Empty array
   * when the rule is engineering-derived.
   */
  transcriptLines: number[];
  /**
   * How the engine enforces this rule. Read by reviewers and surfaced in
   * the Informational audience report next to each finding.
   */
  guidance: string;
  /**
   * True when there is no single source line for the rule and it has been
   * derived from Jeannie's overall posture by the engine author. Surfaced
   * in the Informational report so readers can tell engineering opinion
   * apart from source guidance.
   */
  derived: boolean;
  /** Engineering-derived rationale. Empty when `derived === false`. */
  derivedGuidance: string;
}

export const FRAMEWORK_RULES: readonly FrameworkRule[] = [
  {
    number: 1,
    title: "Pull levers in order — Hybrid Benefit first, always",
    statement:
      "Pull cost levers in a fixed order: Hybrid Benefit first (largest long-run saving), then Reservations, then Savings Plans. Sequence reflects implementation order, not the size of the prize.",
    transcriptLines: [179, 181],
    guidance:
      "The engine renders findings in the sequence Hybrid Benefit → Reservations → Savings Plans regardless of which has the bigger dollar value. Order reflects the order of implementation, not the size of the prize. Renderers must respect `Finding.order` and category sort.",
    derived: false,
    derivedGuidance: "",
  },
  {
    number: 2,
    title: "Two Hybrid Benefit layers — the second is invisible",
    statement:
      "A Windows Server licence applied as Hybrid Benefit pays back in roughly four months on average — and shows up as a discrete line on the invoice. SQL Server Hybrid Benefit is a second, invisible layer: it lives inside compute pricing on marketplace SQL VM images and is never broken out. SQL HB savings must always be presented as a range (Enterprise ceiling, Standard floor), never a point estimate.",
    transcriptLines: [175],
    guidance:
      "Layer 1 is Windows Server rental — visible on the invoice as `Virtual Machines Licenses` rows with non-SQL meters; every dollar disappears if the customer holds Windows Server SA. Layer 2 is SQL Server PAYG — embedded silently in compute pricing for marketplace SQL VM images, never shown as a separate line. The engine MUST estimate Layer 2 from the VM SKU and SQL uplift rates and MUST present it as a RANGE (Enterprise ceiling, Standard floor), never a point estimate. One discovery question (edition installed) collapses the range.",
    derived: true,
    derivedGuidance:
      "Jeannie's transcribed remark only touches SQL HB tangentially (line 175). The 'invisible second layer' framing and the always-a-range invariant are engineering interpretations of Jeannie's broader posture: never quote a single number when you cannot see the underlying configuration from the invoice. Enforced by validateFindings — a sqlHybridBenefit finding without monthlySavingRange is rejected.",
  },
  {
    number: 3,
    title: "Windows rental heuristic — 40% uplift, over 8 cores",
    statement:
      "Windows Hybrid Benefit yields a consistent ~40% saving on the covered VM. Bigger machines produce bigger absolute savings, so focus on VMs with eight or more vCores. The small-VM tail is aggregated rather than chased line by line.",
    transcriptLines: [183, 191],
    guidance:
      "Skip individual Windows HB recommendations on VMs under 8 vCores; aggregate them into a 'small VM tail' line only if material. Rank surviving recommendations by vCore count, largest first. Quote the 40% uplift explicitly in the Informational narrative so the reasoning is auditable.",
    derived: false,
    derivedGuidance: "",
  },
  {
    number: 4,
    title: "Reservations crawl — scope, generation, SSD all matter",
    statement:
      "Reservations apply themselves to matching VMs by 'crawling' across the configured scope, and Instance Size Flexibility lets one reservation cover any size in the same family — but only on one side of the SSD/HDD boundary. D2v2 (HDD) and D2sv2 (SSD) live in separate reservation namespaces and cannot share a commitment. Coverage then breaks for three further reasons within a namespace: scope set too narrowly (single-RG when Shared would crawl across the subscription family); split generations (mixed v3/v5/v6 fragmenting coverage); and staggered end dates that create co-termination overhead. The standing remediation when an estate has both variants in the same family is to standardise on SSD so a single Instance Size Flexibility reservation covers the whole family.",
    transcriptLines: [193, 195, 197],
    guidance:
      "Treat the SSD/HDD divide as a hard precondition: bucket reservations and PAYG VMs by family + generation + storage variant ('s' suffix = premium SSD) before checking for overflow or consolidation. Within each bucket, flag three crawl failures: (a) wrong scope (single-RG when Shared would crawl across the subscription family); (b) split generations (mixed v3/v5/v6 fragmenting coverage — recommend consolidation to v5 or newest stable, exchange-safe per Rule 5); (c) co-termination management overhead from staggered end dates. When the same family appears on both sides of the SSD/HDD boundary, recommend standardising on SSD so Instance Size Flexibility covers the whole family with one reservation.",
    derived: false,
    derivedGuidance: "",
  },
  {
    number: 5,
    title: "Three-year reservations are rarely a trap",
    statement:
      "Three-year reservations deliver the best running rate and remain exchangeable dollar-for-dollar across compute at any point in the term. Workload uncertainty is not a reason to choose one-year — every dollar paid carries across exchanges, no penalty.",
    transcriptLines: [189],
    guidance:
      "Reservation findings default to the 3-year term in the narrative and explicitly address the 'what if the workload changes?' objection by stating that reservations exchange dollar-for-dollar across compute. Required for both Consultant and Informational narratives.",
    derived: false,
    derivedGuidance: "",
  },
  {
    number: 6,
    title: "Customers sprawl, they don't dim",
    statement:
      "Customers very rarely turn things off or trade down — they leave old infrastructure in place. A VM running close to 744 hrs/month is therefore expected, not a finding. The interesting signals are part-time runtime without a documented schedule, apparently-dormant VMs still incurring ambient cost (disks, NICs, Defender, Log Analytics) in the same RG, and stale '_old' / '_copy' / '_test_' resources. AVD pool under-utilisation is healthy behaviour, not waste.",
    transcriptLines: [333, 335, 337],
    guidance:
      "A VM running close to 744 hrs/month is EXPECTED, not a finding. The interesting signals are part-time runtime without a documented schedule, apparently-dormant VMs still incurring ambient cost (disks/network/Defender in the same RG), and stale `_old` / `_copy` / `_test_` resources. AVD pool under-utilisation is healthy behaviour, not a finding.",
    derived: false,
    derivedGuidance: "",
  },
  {
    number: 7,
    title: "The invoice tells you WHERE money goes, not WHETHER it earns",
    statement:
      "An invoice tells you where money goes, not whether the money is well spent. Right-sizing decisions need CPU, memory, IOPS and time-of-day signals that billing data does not carry. Every report must therefore explicitly list what cannot be answered from the invoice alone and recommend a deeper scan as the next track of work.",
    transcriptLines: [315, 323, 327, 329],
    guidance:
      "Every report ends with a 'What this file cannot tell you' section listing: no CPU/memory/disk utilisation, no time-of-day patterns, no network topology, no signal on whether RG sprawl is deliberate isolation or ungoverned growth. The report MUST recommend a DMC scan as Track 3.",
    derived: false,
    derivedGuidance: "",
  },
  {
    number: 8,
    title: "Reverse-engineer runtime from cost when you can",
    statement:
      "For every PAYG VM, derive billed hours by dividing observed compute cost by the SKU's hourly rate. Classify each VM as fully-reserved, reservation-overflow, unreserved-running (with hours), apparently-dormant ($0 across all services in the RG) or unknown-rate. Quote the rate-table version so the math is auditable.",
    transcriptLines: [163],
    guidance:
      "For every VM with non-zero PAYG compute cost, compute billed_hours = payg_cost / hourly_rate from rates.ts and classify into one of: fully-reserved, reservation-overflow, unreserved-running (with exact hours), apparently-dormant ($0 across all services in the RG), unknown-rate (SKU not in table). Hourly rate provenance and rate-table version MUST be cited in the Informational narrative.",
    derived: false,
    derivedGuidance: "",
  },
  {
    number: 9,
    title: "The humanity layer — always include discovery questions",
    statement:
      "Technical findings are only half the picture. Every recommendation that touches production or depends on context the invoice cannot show must carry at least one discovery question. The questions are the tool; the savings are the outcome. The engine never recommends action blind.",
    transcriptLines: [371, 373],
    guidance:
      "Every finding that could impact production or requires configuration knowledge MUST carry at least one discoveryQuestion. The engine never recommends action blind. Enforced by validateFindings: any finding where !(severity==='confirmed' && effort==='low') with zero discoveryQuestions is an error. The questions are the tool. The savings are the outcome.",
    derived: false,
    derivedGuidance: "",
  },
  {
    number: 10,
    title: "Conditional saves stay conditional",
    statement: "",
    transcriptLines: [],
    guidance:
      "Three severities, used honestly: `confirmed` — demonstrable from the invoice alone (e.g. delete a `_old` database). `conditional` — gated on a single discovery question (e.g. 'do you have Windows SA?'). `investigate` — pattern worth surfacing but action depends on context not in the billing data. Confirmed savings can be aggregated into the 'immediate wins' scenario. Conditional savings shown with their range AND the blocking question. `investigate` findings MUST NOT contribute to any aggregated saving total. Enforced by validateFindings.",
    derived: true,
    derivedGuidance:
      "There is no single transcribed Jeannie quote that frames severity discipline this crisply. The rule is the engineering distillation of (a) Jeannie's pattern of refusing to make blind right-sizing claims from invoice data alone (lines 315–329, Rule 7) and (b) her insistence that customers should be told what is known versus what needs a question answered (lines 173–175). Codified here so future rule authors cannot quietly aggregate speculative savings into the headline number.",
  },
] as const;

/** Lookup helper. Throws if `n` is out of range — fail loud, not silent. */
export function getFrameworkRule(n: number): FrameworkRule {
  const r = FRAMEWORK_RULES.find((x) => x.number === n);
  if (!r) {
    throw new Error(
      `Framework rule ${n} does not exist. Valid rules: 1..${FRAMEWORK_RULES.length}.`
    );
  }
  return r;
}

/** True if `n` is a valid framework rule number. */
export function isFrameworkRule(n: number): boolean {
  return n >= 1 && n <= FRAMEWORK_RULES.length;
}
