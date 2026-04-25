markdown# Build: Azure Invoice FinOps Analyser (Electron desktop app)

## Context

I'm Adam Brown, Principal Consultant at Altra Cloud. I work with Azure cost exports 
from customers — typically the "Cost analysis" CSV/XLSX export from the Azure portal 
with columns: ResourceId, ResourceType, ResourceLocation, ResourceGroupName, 
SubscriptionName, ServiceName, Meter, Tags, CostUSD, Cost, Currency.

I want a local Electron app I can ship to colleagues that turns one of these files 
into a FinOps health check report. The analysis must be grounded in the raw data 
(every claim traceable to invoice rows), must follow Jeannie's FinOps framework 
(below) in the correct order, and the output style must shift based on who's 
reading it.

## Jeannie's framework — the source-of-truth rules

This framework comes from Jeannie, an ex-Microsoft Global Black Belt who led 
reservations and FinOps work across the top 200 Azure estates. These rules are 
not optional flavour — they define the order of operations and the reasoning 
style of every finding the engine produces. Codify them into a 
`src/engine/framework.ts` module with JSDoc comments quoting the source, so 
any developer reading the code understands *why* the rules run in this order.

### Rule 1: Pull levers in order — Hybrid Benefit first, always

Jeannie: *"You pull hybrid benefit first because it's the thing that's going to 
save you the most in the long run. You then pull reservations. Then savings 
plans."*

The engine must render findings in this sequence — Hybrid Benefit, then 
Reservations, then Savings Plans — regardless of which has the bigger dollar 
value. The order reflects the order of implementation, not the size of the prize.

### Rule 2: There are two Hybrid Benefit layers, and the second is invisible

Jeannie: *"Most customers only know about the first one. [SQL Server] is the 
part most customers do not see and do not know to challenge."*

- **Layer 1** is Windows Server rental — visible on the invoice as 
  `Virtual Machines Licenses` with non-SQL meters. Every dollar disappears if 
  the customer holds Windows Server SA.
- **Layer 2** is SQL Server PAYG — embedded silently in compute pricing for 
  marketplace SQL VM images. Never shown as a separate line. Must be estimated 
  from the VM SKU and known SQL uplift rates, and always presented as a RANGE 
  (Enterprise ceiling, Standard floor), never a point estimate.

The engine must never quote a single SQL HB figure. It must always show both 
ends of the range and flag that one discovery question (edition installed) 
resolves it.

### Rule 3: The Windows rental heuristic — 40% uplift, over 8 cores

Jeannie: *"It's always 40%. So the bigger the machine, the greater the savings 
over time. The little VMs, it's a waste of time. I would agree. I wouldn't 
even chase that. But anything over eight cores, I would absolutely do."*

The engine must:
- Skip Windows HB recommendations on VMs under 8 vCores unless aggregated 
  saving is material
- Rank HB recommendations by vCore count, largest first
- Present the 40% figure explicitly in the Informational narrative

### Rule 4: Reservations crawl — scope, generation, and SSD matter

Jeannie: *"I am a D2 v2 East. I must find one. I have found one. I attach... 
it seeks and finds another D2 v2 East... and it will crawl and crawl and crawl."*

The engine must flag common reservation-crawl failures:
- **Wrong scope**: reservation scoped to single RG when it could be Shared 
  across subscription family
- **Split generations**: mixed v3/v5/v6 reservations that fragment coverage 
  (v5 is usually the natural consolidation point)
- **Spinning disk vs SSD mismatch**: reservations for spinning-disk SKUs 
  (D2V2) versus SSD (D2Sv2) are named differently and can't crawl across. 
  Recommend standardising on SSD variants.
- **Co-termination**: identify reservations with different end dates and note 
  the management overhead

### Rule 5: Three-year reservations are rarely a trap

Jeannie: *"It's okay if you don't think you're going to have it for three 
years... the three-year reservation is really the best running cost. So you 
can lock a three-year reservation and get out in the first year, second year, 
third year, no penalty, no loss. Every penny goes towards your exchange."*

When the engine recommends reservations, it should default to the 3-year term 
in the narrative and explicitly address the "what if the workload changes?" 
objection. Reservations are exchangeable for compute dollar-for-dollar; the 
engine should say so in the Consultant and Informational narratives.

### Rule 6: Customers sprawl, they don't dim

Jeannie: *"Nobody's dimming. They're sprawling. They leave old stuff and 
don't go up in capability and down in cost, they just don't touch it. If it 
ain't broke, don't fix it."*

This shapes the runtime rules. When the engine sees a VM running close to 
744 hrs/month, that is EXPECTED — most Azure estates leave everything on. 
The interesting signals are:
- VMs running a fraction of the month (scheduled, part-time)
- VMs apparently off all month but still incurring ambient cost
- Old/copy/test resources that were never cleaned up

The engine must not flag "always-on" as a finding in isolation. It only 
becomes a finding when paired with evidence of low utilisation (which needs 
a DMC scan or Azure Monitor — out of scope for this tool).

### Rule 7: The invoice tells you WHERE money goes, not WHETHER the machine is earning it

Jeannie, paraphrased across the conversation: the cost-view invoice cannot 
reveal CPU/memory utilisation. Right-sizing requires a DMC scan.

Every report must end with a "What this file cannot tell you" section listing 
explicitly:
- No CPU/memory/disk utilisation metrics
- No time-of-day patterns
- No network topology visibility
- No confirmation of whether resource-group sprawl is deliberate isolation 
  or ungoverned growth
- These require a DMC scan, and the report must recommend it as Track 3.

### Rule 8: Reverse-engineer runtime from cost when you can

Jeannie, describing the brownfield review method: *"Pull a report like this. 
Take the number of minutes that they ran total, divide by the minutes in the 
month for max capacity, to see how much they're burning it."*

For every VM with non-zero PAYG cost, the engine must compute:
`billed_hours = payg_cost / hourly_rate`
and classify the VM by runtime band. See runtime rules below.

### Rule 9: The humanity layer — always include discovery questions

Jeannie, on how she worked as a GBB: *"I would come in and evaluate their 
tech super easy, but then I would also evaluate their people... the delivery 
to the business, working. Because IT thinks things are great when the 
business is unhappy."*

Every finding that could impact production or requires configuration knowledge 
must carry at least one `discoveryQuestion`. The engine never recommends an 
action blind — it always asks what the customer knows that the invoice 
doesn't show. The questions are the tool. The savings are the outcome.

### Rule 10: Conditional saves stay conditional

Jeannie on data integrity: ambiguous findings must stay ambiguous. The engine 
must have three severity levels and use them honestly:
- **`confirmed`** — the saving is demonstrable from the invoice alone 
  (e.g. delete a `_old` database)
- **`conditional`** — the saving requires a single discovery question 
  (e.g. "do you have Windows SA?")  
- **`investigate`** — the pattern is worth surfacing but the action depends 
  on context we can't see from billing (e.g. Entra DS coexistence with DC VMs)

Confirmed savings can be aggregated into the "immediate wins" scenario. 
Conditional savings must be shown with their range and the blocking question. 
Investigate findings must never be aggregated into a headline saving figure.

---

## Tech stack

- Electron (main + renderer, contextBridge IPC, no nodeIntegration in renderer)
- TypeScript throughout
- Vite for renderer bundling
- React 18 for UI
- xlsx (SheetJS) for workbook parsing
- Fraunces / IBM Plex Sans / JetBrains Mono fonts embedded locally (no CDN)
- No external LLM calls — this is pure deterministic analysis
- Single-file HTML report generation (self-contained, portable)
- CSV generation via papaparse or direct string building

## App flow

1. Drop or pick an .xlsx / .csv Azure cost export
2. Pick audience: **Customer** | **Consultant** | **Informational**
3. Pick currency display (detected from file, override-able)
4. Customer name override (for report header)
5. Click Analyse
6. See preview in-app with all findings, the runtime reading, and the savings ladder
7. Export: HTML report | CSV findings | Both

## The FinOps rule engine

Build `src/engine/` with pluggable rules. Each rule is a file exporting:

```typescript
export interface Finding {
  id: string;
  category: 'lever' | 'runtime' | 'anomaly';
  jeannieRule: number;          // which of the 10 framework rules this implements
  order: number;
  title: string;
  severity: 'confirmed' | 'conditional' | 'investigate';
  monthlySaving: number | null;
  monthlySavingRange?: [number, number];
  annualSaving: number | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: EvidenceRow[];
  narrative: {
    customer: string;
    consultant: string;
    informational: string;
  };
  discoveryQuestions: string[];  // required — enforce at least 1 unless 
                                  // severity === 'confirmed' AND effort === 'low'
  effort: 'low' | 'medium' | 'high';
  requiresConfirmation: string[];
}

export interface EvidenceRow {
  resourceId: string;
  meter: string;
  cost: number;
  reason: string;
}

export interface Rule {
  id: string;
  name: string;
  framework: { rule: number; quote: string };  // traceability to Jeannie's framework
  evaluate(invoice: ParsedInvoice): Finding | Finding[] | null;
}
```

The rules to implement, in this order (matching Jeannie's Rule 1):

### LEVERS (framework rules 1-5)

1. **windowsHybridBenefit** (Jeannie Rule 2, 3) — find all 
   `Virtual Machines Licenses` rows with non-SQL meters. Sum = confirmed monthly 
   saving if customer holds Windows Server SA. Rank by vCore count; suppress 
   VMs under 8 cores from individual recommendations (aggregate only) per 
   Jeannie's 8-core threshold.

2. **sqlHybridBenefit** (Jeannie Rule 2) — find `Virtual Machines Licenses` 
   rows where the ResourceId or VM name contains `sql`. Output a RANGE always 
   — Enterprise uplift ceiling vs Standard floor. Never quote a single number.

3. **reservationScopeCheck** (Jeannie Rule 4) — find cases where the same SKU 
   has both reservation orders AND non-zero PAYG compute. The PAYG is 
   overflow. Check for scope/generation/SSD-variant issues per Jeannie Rule 4.

4. **reservationGenerationConsolidation** (Jeannie Rule 4) — detect mixed 
   v3/v5/v6 reservations for the same VM family. Recommend consolidation to 
   v5 (or newest stable) with the exchange-preserves-value reasoning from 
   Jeannie Rule 5.

5. **appServiceSavingsPlan** (Jeannie Rule 1 — Savings Plans) — find 
   `Azure App Service` rows, group by App Service Plan, count unique plans. 
   Recommend 3-year Compute Savings Plan at 40-65% discount.

### RUNTIME (framework rules 6-8)

6. **vmRuntimeDerivation** (Jeannie Rule 8) — for every VM, divide VM-service 
   PAYG cost by the published hourly rate. Categorise each VM:
   - `fully-reserved` — $0 compute cost AND matching reservation exists
   - `reservation-overflow` — non-zero cost AND reservation exists
   - `unreserved-running` — non-zero cost, no reservation → exact hours
   - `apparently-dormant` — $0 across ALL services AND no reservation covers 
     the SKU
   - `unknown-rate` — SKU not in rate table

7. **dormantVmCluster** (Jeannie Rule 6) — cluster `apparently-dormant` VMs 
   by resource group. Compute AMBIENT cost (all non-VM services in same RG: 
   disks, storage, network, Defender, Log Analytics). Flag as `investigate`, 
   not `confirmed` — per Jeannie Rule 10.

8. **avdPoolUtilisation** (Jeannie Rule 6) — find pooled AVD/VDI VMs. 
   Compare VM count to reservation count. Compute fleet utilisation ceiling. 
   Note that under-utilisation is healthy behaviour for session host pools, 
   not a finding — per Jeannie Rule 6.

9. **partTimeVmAnomaly** (Jeannie Rule 8) — VMs running <50% of the month 
   that have no obvious scheduling pattern. Flag for investigation — either 
   they're scheduled correctly (in which case document it) or they're 
   unstable (in which case fix it).

### ANOMALIES (framework rules 7, 9, 10)

10. **managedHsmReview** — `Key Vault` rows with `managedhsms/` in ResourceId. 
    Flag for downgrade review.

11. **sqlDatabaseLegacy** — SQL databases with names containing `_old`, 
    `_copy`, `_bak`, `_backup`, `_archive`, `_test_`, or timestamp pattern 
    `_\d{4}-\d{2}-\d{2}t\d{2}-\d{2}z`. Sum cost. Flag for deletion (with 
    48-hour confirmation question per Jeannie Rule 9).

12. **privateEndpointSprawl** — `Virtual Network` rows with Meter 
    `Standard Private Endpoint`, grouped by RG. Non-prod RGs (names containing 
    `-dev-`, `-test-`, `-stage-`, `dev_`, `test_`) are candidates for 
    Service Endpoints.

13. **fabricCapacityPause** — any `Microsoft Fabric` capacity with 
    `Compute Pool Capacity Usage CU`. Model 3 pause schedules. Include 
    discovery questions about overnight batch jobs.

14. **diskOversizing** — group managed disks by size tier. Flag P40 disks 
    attached to VMs in VDI/AVD resource groups. Flag as `conditional` — 
    needs IOPS validation before action.

15. **serviceBusNonProdPremium** — Premium Service Bus namespaces where the 
    namespace name contains non-prod markers. Flag as `conditional` — 
    Premium may be required for VNet integration.

16. **appGatewayPerEnv** — count distinct App Gateways. If >5, flag 
    consolidation opportunity. High effort, conditional severity.

17. **sqlMiContinuous** — SQL Managed Instances in non-prod RGs running 
    continuously. Recommend stop/start schedule.

18. **entraDsCoexistence** — both `Microsoft Entra Domain Services` cost 
    AND VMs matching DC patterns. Flag as `investigate` ONLY — never 
    recommend action (Jeannie Rule 10).

19. **bastionStandardNonProd** — Azure Bastion on Standard tier in non-prod 
    RGs. Confirmed downgrade candidate.

20. **cogSearchDuplicate** — multiple Cognitive Search instances, flag 
    non-prod/PoC for Basic tier.

21. **cosmosProvisionedNonProd** — Cosmos DB at low RU/s provisioned in 
    non-prod. Recommend serverless.

22. **vpnGatewayAzReview** — VPN Gateways on AZ tier for VDI connectivity. 
    Conditional — needs confirmation AZ is not a hard requirement.

## The hourly rate lookup table

Ship `src/engine/azureRates.ts` with Linux PAYG hourly rates for these SKUs 
across regions (`us-east`, `us-east-2`, `uk-south`, `west-europe`, 
`north-europe`). Include:
- B-series, D v3/v4/v5/v6, E v3/v4/v5, F v2

Add a prominent disclaimer noting rates are approximate retail list prices 
as of a specific date, should be refreshed quarterly, and a future version 
should fetch live from Azure's retail pricing API. Include a Windows uplift 
per-core rate (~$0.046/core/hr) and SQL uplift rates (Enterprise ~$0.3978, 
Standard ~$0.1014, Web ~$0.0338) as separate lookups.

## Cross-checking

Every analysis run validates itself:

```typescript
export function validateFindings(
  findings: Finding[], 
  invoice: ParsedInvoice
): ValidationReport {
  // 1. Sum of all confirmed savings must not exceed total invoice cost
  // 2. Every finding's evidence rows must exist in the invoice
  // 3. Sum of evidence row costs must equal the finding's claimed cost 
  //    (or finding must declare it's an estimate with range)
  // 4. Service percentages in any summary must sum to ~100% (±0.5)
  // 5. Annualised figures must equal monthly × 12 exactly
  // 6. Counts of unique resources must match what's in the data
  // 7. Every non-low-effort, non-confirmed finding must have at least one 
  //    discovery question (Jeannie Rule 9 enforcement)
  // 8. `investigate` severity findings must not contribute to any 
  //    aggregated saving total (Jeannie Rule 10 enforcement)
}
```

The validation report is an appendix in the HTML output. For Informational 
audience, it's visible. For Customer and Consultant, it's collapsed but 
available. If validation fails, the export button shows a warning badge 
but doesn't block — the user can still ship with known issues, they just 
see them.

## Audience-aware rendering

Every finding carries three narratives. The report template varies by audience:

### Customer
- Warm, direct, minimal jargon
- Lead with the saving, then the action, then the question
- No technical acronyms without explanation
- No internal terms (DMC, Azure Migrate, WGS)
- Hero headline: "£X/year of cost we can help you recover"
- No appendix, no raw evidence tables
- `investigate` findings rendered as "worth a conversation" not "anomaly"
- No reservation/PAYG internals — say "license commitment" not "RI"

### Consultant (default)
- Technical, dense, accurate
- Shows SKU, meter name, resource group, subscription
- Evidence counts per finding
- Full ladder with all scenarios
- Discovery questions visible
- References to Jeannie framework rule numbers where relevant

### Informational
- Most verbose — shows engine working
- Includes hourly rate lookups used
- Shows why a finding is `confirmed` vs `conditional` vs `investigate`
- Validation report inline
- Jeannie framework rule quotations in callouts next to each finding
- Alternative readings where ambiguous

## Output formats

### HTML report
- Single self-contained file, no external assets
- Design system matches the reference I'll attach: near-black paper, 
  bone-and-tungsten-amber accent, Fraunces display, IBM Plex Sans body, 
  JetBrains Mono for numbers
- Staggered reveal on scroll
- Savings ladder with floor-to-ceiling visual
- File name: `{customerName}_{period}_finops_{audience}.html`

### CSV output
Primary CSV: one row per finding, columns:
id, category, jeannie_rule, order, title, severity, confidence,
monthly_saving_low, monthly_saving_high, annual_saving_low,
annual_saving_high, effort, evidence_count, evidence_total_cost,
requires_confirmation, discovery_questions, action_description

Evidence CSV: one row per evidence row, columns:
finding_id, resource_id, meter, cost, reason

File names: `{customerName}_{period}_finops.csv` and 
`{customerName}_{period}_finops_evidence.csv`.

## UI layout

Three-pane:
- **Left**: file drop zone, audience selector (segmented control), currency 
  display, customer name override, analyse button
- **Centre**: live preview of the report in current audience style
- **Right**: findings list with severity pills, clickable to scroll preview. 
  Validation indicator at top (green tick or red count)

## Project structure
/src
/main              # Electron main process
/preload
/renderer
/components      # React UI
/styles          # tokens.css with design system CSS variables
/engine
index.ts         # orchestrator
framework.ts     # Jeannie's 10 rules as JSDoc-documented constants
parse.ts         # XLSX/CSV → ParsedInvoice
rates.ts         # hourly rate lookup
validate.ts      # cross-check
/rules           # one file per rule
/render
html.ts          # finding → HTML section, audience-aware
csv.ts           # findings → CSV
template.ts      # shell HTML with embedded CSS and fonts
/types
/assets
/fonts
/test
/fixtures
engine.test.ts
framework.test.ts  # tests that enforce Jeannie rules (e.g. investigate
# severity never contributes to totals)

## Testing

Vitest tests that:
- Parse the attached sample invoice successfully
- Validate framework-rule enforcement (see below)
- Validate that confirmed savings never exceed total invoice
- Validate evidence cost sum equals finding claimed cost
- Test each rule in isolation with minimal fixture data

Framework-rule enforcement tests are non-negotiable. Examples:
- "SQL Hybrid Benefit finding must have a range, not a point estimate" 
  (Rule 2)
- "Windows HB recommendations must be ranked by vCore count descending" 
  (Rule 3)
- "Findings with severity `investigate` must not appear in any 
  savingsLadder total" (Rule 10)
- "Every finding with effort !== 'low' or severity !== 'confirmed' must 
  have at least one discoveryQuestion" (Rule 9)

## Build targets

- `npm run dev` — Electron dev mode with hot reload
- `npm run build` — production build for macOS (Apple Silicon primary)
- `npm run build:win` / `build:linux` — other platforms
- Use electron-builder

## Style and code quality

- Strict TypeScript, no `any` except at SheetJS boundary
- All numbers pass through a `Money` type with explicit currency
- All percentages explicit: `Percent(0.15)` not `0.15`
- Prettier + ESLint
- No `console.log` in production
- Error boundaries around renderer

## What I want back first

Don't generate the whole thing in one shot. Give me, in this order:

1. `src/engine/framework.ts` — Jeannie's 10 rules codified as a const, 
   each with `number`, `title`, `quote` (verbatim source), and `guidance` 
   (how the engine enforces it). This is the foundation.
2. `src/types/` — Finding, Rule, ParsedInvoice, EvidenceRow
3. `src/engine/rates.ts` — hourly rate table with disclaimer
4. `src/engine/parse.ts` — with ParsedInvoice type and parser
5. One complete rule file — `rules/windowsHybridBenefit.ts` — that implements 
   Jeannie Rules 2 and 3, with the framework reference in metadata, as a 
   reference pattern for the others
6. `src/engine/validate.ts` — cross-check including framework-rule enforcement
7. One framework-rule test file to show how enforcement is verified
8. Then stop. I'll review before you continue.

Do NOT scaffold the Electron shell, React components, or HTML template until 
the engine and framework pattern is signed off. The engine is the value; the 
shell is ceremony.

## Reference material I'll attach

- The sample Azure cost-export invoice file
- A reference HTML report for the design system
- The transcript of my conversation with Jeannie (as source material for the 
  framework quotations — do NOT ship the transcript in the app, use it only 
  to verify your quote attribution)

The key shift from my previous draft: Jeannie's rules are now the architecture, not flavour text. They get their own module (framework.ts), every rule file declares which framework rule it implements, the validation layer enforces the rules that matter (no SQL point estimates, no aggregation of investigate findings, discovery questions are mandatory where appropriate), and the Informational audience shows the framework quotations inline.
This does two things. First, it makes the engine's reasoning auditable — anyone reviewing the code can trace a finding back to the framework rule it implements and the verbatim source quote. Second, it keeps future rules honest. When you or a colleague adds rule 23 next month, they have to declare which framework rule it serves, and if none applies, they have to think about why.
When you paste this into Claude Code, attach the three reference files (invoice, HTML report, conversation transcript). Push back if it tries to skip the framework module or scaffold the Electron shell early — the framework has to land first.