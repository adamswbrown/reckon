# Optimisation rules reference

This document describes the rules Reckon applies to an Azure cost-analysis
export to produce a FinOps health-check report. There are two layers,
and they have different jobs.

- **Framework principles** (10 of them) — the constitution. They define
  the order of operations, the reasoning style, the severity discipline,
  and the humanity layer. They live in `src/engine/framework.ts`.
- **Rule implementations** (22 today) — concrete detection logic. Each
  one declares which framework principle it implements. They live in
  `src/engine/rules/`.

The framework is small and changes rarely. The rule implementations are
where most additions happen — a new SKU pattern, a new anomaly, a new
sprawl signal. Adding one is a controlled, well-understood change; see
[RULE_AUTHORING.md](RULE_AUTHORING.md) for the recipe.

---

## Layer 1: the ten framework principles

Every rule implementation must cite one of these. The validator
(`validateFindings`) enforces several of them as runtime invariants —
violations are surfaced as validation errors in the report appendix and
visibly flagged in the export UI.

### Principle 1 — Pull levers in order: Hybrid Benefit first, always

> The levers you pull, you pull hybrid benefit first because it's the
> thing that's going to save you the most in the long run. You then
> pull commitments. Then compute plans.

The engine renders findings in the sequence Hybrid Benefit → Reservations
→ Compute Savings Plans **regardless of which has the bigger dollar
value**. The order reflects how the decisions compound, not the size of
any single line.

**Enforced by:** `ALL_RULES` declaration in `src/engine/index.ts` (rules
listed in framework order); renderers respect `Finding.order` and
`Finding.category` sort.

---

### Principle 2 — Two Hybrid Benefit layers; the second is invisible

Hybrid Benefit applies on two separate layers, and customers usually
only know about the first.

- **Layer 1 — Windows Server rental.** Visible on the invoice as
  `Virtual Machines Licenses` rows with non-SQL meters. Every dollar
  disappears if the customer holds Windows Server Software Assurance.
- **Layer 2 — SQL Server uplift.** Embedded silently in compute pricing
  for marketplace SQL VM images. **Never shown as a separate line.**
  Must be estimated from the VM SKU and SQL uplift rates, and **must**
  be presented as a range (Enterprise ceiling, Standard floor), never
  a point estimate.

**Enforced by:** the validator rejects any `sqlHybridBenefit:*` finding
without a `monthlySavingRange`. One discovery question — "which SQL
edition is installed?" — collapses the range.

**Implemented by:** `windowsHybridBenefit.ts` (Layer 1),
`sqlHybridBenefit.ts` (Layer 2).

---

### Principle 3 — Windows rental heuristic: 40% uplift, over 8 cores

> It's always 40%. So the bigger the machine, the greater the savings
> over time. The little VMs, it's a waste of time. Anything over eight
> cores, I would absolutely do.

The engine:

- Skips Windows HB recommendations on VMs under 8 vCores (per VM).
- Aggregates the small-VM tail into a single observational finding
  rather than flooding the report with low-value lines.
- Ranks the surviving recommendations by vCore count, largest first.
- Quotes the 40% figure in the Informational narrative for auditability.

**Implemented by:** `windowsHybridBenefit.ts` (vCore split logic).

---

### Principle 4 — Reservations crawl: scope, generation, SSD all matter

> I am a D2v2 East. I must find one. I have found one ... it will
> crawl and crawl and crawl. ... It's named for the spinning disk type
> or SSD. So you have spinning disk on one, D2V2, and you have SSD on
> the other. You have to have two different reservations.

A reservation only crawls within an exact match. The engine flags four
common crawl-failure modes:

1. **Wrong scope** — reservation pinned to a single resource group when
   `Shared` scope would crawl across the subscription family.
2. **Split generations** — mixed v3/v5/v6 reservations on the same
   family fragment coverage. Recommend consolidation to v5 or newest
   stable.
3. **SSD/spinning-disk variant mismatch** — `D2V2` and `D2sV2` are
   separate reservation namespaces. Standardise on the SSD variant.
4. **Co-termination overhead** — staggered end dates create unnecessary
   management burden.

**Implemented by:** `reservationScopeCheck.ts`,
`reservationGenerationConsolidation.ts`.

---

### Principle 5 — Three-year reservations are rarely a trap

> The three-year reservation is really the best running cost. So you
> can lock a three-year reservation and get out in the first year,
> second year, third year, no penalty, no loss. Every penny goes towards
> your exchange.

The "what if the workload changes?" objection is the most common reason
customers refuse a 3-year commitment. The engine rebuts it explicitly in
every reservation finding's Consultant and Informational narratives:
reservations exchange dollar-for-dollar across compute, no penalty.

**Enforced by:** every reservation finding states the exchange property
in the narrative. Verified by `framework.test.ts`.

**Implemented by:** `appServiceSavingsPlan.ts`,
`reservationGenerationConsolidation.ts`.

---

### Principle 6 — Customers sprawl, they don't dim

> Almost everything runs 24/7. Nobody's dimming. They're sprawling.
> They leave old stuff and don't go up in capability and down in cost,
> they just don't touch it.

A VM running close to 744 hours/month is **expected behaviour**, not a
finding. The interesting signals are:

- Part-time runtime without a documented schedule.
- Apparently-dormant VMs still incurring ambient cost (disks, NICs,
  Defender, Log Analytics in the same RG).
- Stale `_old` / `_copy` / `_test_` resources.
- Pooled AVD/VDI under-utilisation — which is healthy behaviour, not a
  finding (session-host pools are designed to over-provision).

**Implemented by:** `dormantVmCluster.ts`, `partTimeVmAnomaly.ts`,
`avdPoolUtilisation.ts`, `sqlDatabaseLegacy.ts`,
`privateEndpointSprawl.ts`, `appGatewayPerEnv.ts`,
`cogSearchDuplicate.ts`, `cosmosProvisionedNonProd.ts`,
`sqlMiContinuous.ts`.

---

### Principle 7 — The invoice tells you WHERE money goes, not WHETHER it earns

The cost-view invoice cannot reveal CPU, memory, or disk utilisation.
Right-sizing is therefore **out of scope** for an invoice-only review.
Every report ends with a "What this file cannot tell you" section
listing the explicit limits and recommends a follow-up utilisation
assessment as the next engagement.

**Enforced by:** `renderLimits()` in `html.ts` always emitted.

**Implemented by:** `diskOversizing.ts` (range-only, gated on IOPS
discovery), `vpnGatewayAzReview.ts`.

---

### Principle 8 — Reverse-engineer runtime from cost when you can

> Pull a report like this. Take the number of minutes that they ran
> total, divide by the minutes in the month for max capacity, to see
> how much they're burning it.

For every VM with non-zero PAYG compute cost, the engine computes
`billed_hours = payg_cost / hourly_rate` from the rates table and
classifies the VM into one of:

- `fully-reserved` — $0 compute and a matching reservation exists.
- `reservation-overflow` — non-zero cost despite reservation present.
- `unreserved-running` — non-zero cost, no reservation, exact hours.
- `apparently-dormant` — $0 compute and no covering reservation.
- `unknown-rate` — SKU not in the rate table.

**Hourly rate provenance** (capture date, source URL) is cited in the
Informational narrative — non-negotiable, so the analysis stays
auditable when the rate table ages.

**Implemented by:** `vmRuntimeDerivation.ts`, `partTimeVmAnomaly.ts`.

---

### Principle 9 — The humanity layer: always include discovery questions

Every finding that could impact production or requires configuration
knowledge **must** carry at least one discovery question. The engine
never recommends action blind. The questions are the deliverable; the
savings are the outcome of answering them.

**Enforced by:** `validateFindings` flags any finding where
`!(severity === 'confirmed' && effort === 'low')` with zero
discoveryQuestions as an error.

**Implemented by:** every rule. The `managedHsmReview.ts` rule is the
canonical example — it has no quantifiable saving, only a discovery
question.

---

### Principle 10 — Conditional saves stay conditional

Severity is a contract with the customer. Three labels, used honestly:

- **`confirmed`** — saving is demonstrable from the invoice alone
  (e.g. delete a `_old` database). Aggregated into the headline
  immediate-wins figure.
- **`conditional`** — saving requires one discovery question
  (e.g. "do you have Windows SA?"). Shown as a range with the blocking
  question. Floor estimate only contributes to the headline.
- **`investigate`** — pattern is worth surfacing but action depends on
  context outside the billing data. **Excluded from any aggregated
  saving total.**

**Enforced by:** `validateFindings` rejects any finding aggregation that
includes `investigate` severity. The savings ladder's investigate rung
shows "excluded from totals" as text, never a number.

**Implemented by:** every rule, via the `severity` field on each Finding.
`entraDsCoexistence.ts` is a pure investigate-only rule.

---

## Layer 2: the 22 rule implementations

Rules group into three categories: **levers** (the three-tier pricing
optimisation), **runtime** (what the invoice can say about how things
actually run), and **anomalies** (sprawl, leftovers, tier mismatches).

The engine evaluates them in the order shown — framework Principle 1
order for levers, then runtime, then anomalies. Within each group the
order is meaningful and stable.

### Levers (5 rules)

| File | Implements | What it detects |
|---|---|---|
| `windowsHybridBenefit.ts` | Principle 2, 3 | `Virtual Machines Licenses` rows with non-SQL meters. Splits at 8 vCores; surfaces large VMs individually, aggregates the small tail. |
| `sqlHybridBenefit.ts` | Principle 2 | VMs whose `resourceId`, RG name, or meter contains `sql`/`mssql`. Estimates the SQL uplift as a range (Enterprise ceiling / Standard floor). Never a point estimate. |
| `reservationScopeCheck.ts` | Principle 4 | Same VM family + region with reservation rows AND non-zero PAYG. The PAYG is overflow — usually wrong scope, wrong variant, or wrong count. |
| `reservationGenerationConsolidation.ts` | Principle 4, 5 | Same VM family with reservations across two or more generations. Recommends consolidation to v5 (or newest stable) and cites the dollar-for-dollar exchange property. |
| `appServiceSavingsPlan.ts` | Principle 1, 5 | App Service Plans grouped by `serverfarms/<plan>` segment. Recommends a 3-year Compute Savings Plan with a 30–50% discount band. |

### Runtime (4 rules)

| File | Implements | What it detects |
|---|---|---|
| `vmRuntimeDerivation.ts` | Principle 8 | Reverse-engineers billed hours from PAYG cost / hourly rate for every VM. Classifies into the five runtime bands. |
| `dormantVmCluster.ts` | Principle 6 | Apparently-dormant VMs grouped by RG; computes the ambient cost (disks, network, monitoring) still being incurred even with the VM off. |
| `avdPoolUtilisation.ts` | Principle 6 | Pooled AVD/VDI hosts. Reports the fleet utilisation ceiling but does not flag low utilisation as a finding (pools are designed for it). |
| `partTimeVmAnomaly.ts` | Principle 8 | VMs running less than 50% of the period without a documented schedule. Investigation candidate either way. |

### Anomalies (13 rules)

| File | Implements | What it detects |
|---|---|---|
| `managedHsmReview.ts` | Principle 9 | `Key Vault` rows with `managedhsms/`. Flags for downgrade review; investigation-only with discovery question. |
| `sqlDatabaseLegacy.ts` | Principle 6, 10 | SQL databases with names matching `_old`, `_copy`, `_bak`, `_backup`, `_archive`, `_test_`, or a date stamp. Confirmed deletion candidates. |
| `privateEndpointSprawl.ts` | Principle 6 | Private endpoint rows grouped by RG. Non-prod RGs (names containing `-dev-`, `-test-`, `-stage-`, etc.) are candidates for Service Endpoints. |
| `fabricCapacityPause.ts` | Principle 9 | Microsoft Fabric capacity rows. Models 3 pause schedules; gates on overnight batch-job discovery question. |
| `diskOversizing.ts` | Principle 7 | Managed disks grouped by tier. P40 disks attached to AVD/VDI RGs. Range-only — needs IOPS validation before action. |
| `serviceBusNonProdPremium.ts` | Principle 9 | Premium Service Bus namespaces with non-prod markers. Conditional — Premium may be required for VNet integration. |
| `appGatewayPerEnv.ts` | Principle 6 | Counts distinct App Gateways. Flags consolidation opportunity above 5. High-effort, conditional. |
| `sqlMiContinuous.ts` | Principle 6 | SQL Managed Instances in non-prod RGs running continuously. Recommends a stop/start schedule. |
| `entraDsCoexistence.ts` | Principle 10 | Microsoft Entra Domain Services cost AND VMs matching DC patterns. Investigation-only — never recommends action. |
| `bastionStandardNonProd.ts` | Principle 10 | Azure Bastion on Standard tier in non-prod RGs. Confirmed downgrade candidate. |
| `cogSearchDuplicate.ts` | Principle 6 | Multiple Cognitive Search instances. Flags non-prod / PoC for the Basic tier. |
| `cosmosProvisionedNonProd.ts` | Principle 6 | Cosmos DB at low RU/s provisioned in non-prod RGs. Recommends serverless. |
| `vpnGatewayAzReview.ts` | Principle 7 | VPN Gateways on AZ tier for VDI connectivity. Conditional — AZ is a hard requirement for some scenarios. |

---

## How a rule runs

The orchestrator (`src/engine/index.ts`) is small, and worth reading in
full. The flow:

1. `parseInvoice(buf, filename)` reads the workbook, extracts the rows,
   determines the period and currency, and returns a `ParsedInvoice`.
2. The orchestrator iterates through `ALL_RULES` in framework order. Each
   rule's `evaluate(invoice)` is a pure function that returns one
   `Finding`, an array, or `null`.
3. Findings are concatenated in emission order. `Finding.order` is
   re-stamped to be the global render order.
4. `validateFindings(findings, invoice)` runs the cross-checks listed
   below.
5. The result is `{ invoice, findings, validation, immediateWinsMonthly }`,
   where `immediateWinsMonthly` is the headline figure (confirmed full +
   conditional floor, investigate excluded).

The renderers read this result. The voice filter
(`src/render/voice.ts`) shapes each narrative for the audience at
render time — the rules emit one set of three narratives, and the
renderer picks the right voice and humanises the prose.

---

## What the validator enforces

`validateFindings` runs after every analysis and produces a
`ValidationReport` with `info`/`warning`/`error` issues. It is the
last line of defence for the framework principles.

The currently enforced invariants:

- **Total saving cannot exceed total invoice cost.** A finding that
  claims to save more than the customer is paying is a bug.
- **Every evidence row's `resourceId` and `meter` must exist in the
  parsed invoice rows.** No fabricated evidence.
- **Evidence-row cost sum must equal the finding's claimed cost** —
  unless the finding declares itself an estimate (range present).
- **Annualised figures must equal monthly × 12 exactly.** No rounding
  drift between hero and per-finding numbers.
- **`sqlHybridBenefit:*` findings must have a `monthlySavingRange`.**
  Principle 2 enforcement — never a SQL HB point estimate.
- **`investigate` findings cannot contribute to any aggregated saving
  total.** Principle 10 enforcement.
- **Findings where `!(severity === 'confirmed' && effort === 'low')`
  must have at least one discovery question.** Principle 9 enforcement.

Validation results are surfaced in three places: an inline appendix in
the Informational report, a collapsed appendix in the Customer and
Consultant reports, and a counter pill in the Electron app's right pane.

---

## See also

- [README.md](../README.md) — high-level overview and quick start.
- [RULE_AUTHORING.md](RULE_AUTHORING.md) — how to add or modify a rule.
- `src/engine/framework.ts` — the source-of-truth rule definitions, with
  verbatim source guidance and audit references.
- `src/test/framework.test.ts` — the framework-invariant tests; read
  these to understand what cannot change without test fixes.
