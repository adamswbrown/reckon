# Adding or updating a rule

This is the recipe for changing the engine's detection logic. Read it
fully before touching code — there is a small but rigid contract that
keeps the report honest.

If you are adding a new framework principle (one of the ten in
`framework.ts`), stop and ask first. Eleven principles is almost
certainly the wrong answer; usually the new behaviour belongs as a new
rule implementation under one of the existing principles.

---

## When to add a rule vs. extending an existing one

**Add a new rule** when the detection has its own SKU pattern, its own
discovery question, and its own action. A new sprawl signal, a new
licensing optimisation, a new tier mismatch — these are new rules.

**Extend an existing rule** when the new detection produces the same
finding type with a slightly different evidence shape. A second SQL
edition pattern, an additional meter name to capture, a new resource
group naming convention — these are usually edits to the existing rule
file, not new files.

**Don't add a rule** to capture a one-customer-only signal. The engine
is meant to apply across estates; bespoke logic belongs in a
customer-specific post-process step, not in `src/engine/rules/`.

---

## The contract

Every rule file under `src/engine/rules/` exports a single
`Rule` object. The shape:

```typescript
export interface Rule {
  id: string;                  // unique, kebab-case-ish, used in finding ids
  name: string;                // human-readable name for the rule itself
  framework: {
    rule: number;              // 1..10 — must cite a framework principle
    quote: string;             // verbatim guidance, copied from framework.ts
  };
  evaluate(invoice: ParsedInvoice): Finding | Finding[] | null;
}
```

A `Finding` carries:

```typescript
{
  id: string;                       // unique across the whole report
  category: 'lever' | 'runtime' | 'anomaly';
  jeannieRule: number;              // matches `framework.rule` — internal name
  order: number;                    // re-stamped by the orchestrator
  title: string;                    // technical title, used as a dek
  severity: 'confirmed' | 'conditional' | 'investigate';
  monthlySaving: number | null;     // null if range-only or observation
  monthlySavingRange?: [number, number];
  annualSaving: number | null;      // exactly monthly × 12 if non-null
  annualSavingRange?: [number, number];
  currency: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: EvidenceRow[];
  narrative: {
    customer: string;
    consultant: string;
    informational: string;
  };
  discoveryQuestions: string[];     // mandatory unless confirmed + low effort
  effort: 'low' | 'medium' | 'high';
  requiresConfirmation: string[];   // pre-action checks
}
```

The validator enforces several of these — see
[RULES.md § What the validator enforces](RULES.md#what-the-validator-enforces).

---

## The recipe

### 1. Pick the framework principle you're implementing

Every rule must cite one of the ten principles. Read
[RULES.md § Layer 1](RULES.md#layer-1-the-ten-framework-principles) and
pick the one this rule operationalises. If you cannot honestly cite one,
the rule probably should not exist.

### 2. Create the rule file

Use an existing rule of the same shape as a template:

| If your rule is… | Start from |
|---|---|
| A licence/pricing optimisation | `src/engine/rules/windowsHybridBenefit.ts` |
| A range-only finding gated on a discovery question | `src/engine/rules/sqlHybridBenefit.ts` |
| A reservation-coverage check | `src/engine/rules/reservationScopeCheck.ts` |
| A sprawl/anomaly signal | `src/engine/rules/sqlDatabaseLegacy.ts` |
| An investigation-only signal | `src/engine/rules/entraDsCoexistence.ts` |

Name the file by the detection (`appGatewayPerEnv.ts`, not
`rule_anomaly_3.ts`). The `id` field on the `Rule` should match the file
name in camelCase.

### 3. Cite the framework principle

```typescript
import { getFrameworkRule } from "../framework";

export const myRule: Rule = {
  id: "myRule",
  name: "Human-readable name",
  framework: {
    rule: 6,                                       // pick one
    quote: getFrameworkRule(6).verbatimQuote,
  },
  // ...
};
```

`getFrameworkRule(n)` throws on invalid `n`, so you cannot silently cite
a principle that does not exist.

### 4. Implement `evaluate(invoice)`

A pure function. Read rows out of `invoice.rows`, do whatever pattern
matching, and return:

- `null` when the rule does not fire.
- A single `Finding` when there is one signal.
- A `Finding[]` when the rule produces multiple findings (e.g. one per
  resource group, one per VM family).

Keep it simple. Helper functions go below the rule export, or in
`src/engine/rules/_helpers.ts` if multiple rules need them.

### 5. Choose a severity and respect it

The severity contract from Principle 10:

- **`confirmed`** — the saving is demonstrable from the invoice alone.
  No discovery question needed before action. Examples: deleting a
  database whose name matches `_old_`, downgrading a Bastion in a non-prod
  RG.
- **`conditional`** — the saving requires one discovery question. The
  finding **must** carry a `monthlySavingRange` if the question's answer
  changes the dollar value (e.g. "is this Windows VM running Software
  Assurance cores?").
- **`investigate`** — the pattern is worth surfacing but acting on it
  needs context the invoice cannot provide. The finding **must not**
  carry a `monthlySaving` or `monthlySavingRange` — the validator will
  reject any aggregation that includes investigate findings.

If you cannot decide between conditional and investigate, default to
investigate. Conservatism is the right error.

### 6. Add discovery questions

Required unless the finding is `severity === 'confirmed'` AND
`effort === 'low'`. The validator will fail the analysis otherwise.

Discovery questions should be answerable by one named owner, in one
sentence, without further investigation. Bad: "is this VM right-sized?"
(needs a DMC scan). Good: "do you hold Windows Server Software
Assurance with at least 16 cores available to deploy to Azure?"

### 7. Write the three narratives

The renderer's voice filter (`src/render/voice.ts`) handles the heavy
lifting — humanises the prose and shapes per audience — but the rule
must provide three different starting points. Don't paste the same
paragraph into all three fields.

- **Customer** — lead with the saving and the action. No SKU codes, no
  meter names, no FinOps acronyms (the voice filter catches some but
  cannot recover from a paragraph that is just jargon). One discovery
  question stated plainly.
- **Consultant** — SKU, meter, RG, region. The exact action: "Apply via
  VM blade → Configuration → Azure Hybrid Benefit." Cite the framework
  principle number.
- **Informational** — the engine showing its working. Evidence row
  count, formula behind any range, the framework principle, validator
  invariants relevant to this finding.

### 8. Build the evidence rows

Every dollar in the finding must reconcile to evidence row costs. The
validator enforces this. Each evidence row carries:

```typescript
{
  resourceId: string;   // must match an invoice row's resourceId
  meter: string;        // must match an invoice row's meter
  cost: number;         // must match the invoice row's cost
  reason: string;       // why this row is evidence for this finding
}
```

If the finding is a range estimate, the evidence cost sum will not equal
the finding's saving — that's fine, but the finding **must** declare a
`monthlySavingRange` (the validator uses the presence of a range as the
"this is an estimate, evidence-vs-saving reconciliation is loose" flag).

### 9. Register the rule

Add the import and the entry in `ALL_RULES` in `src/engine/index.ts`.
The order matters — Principle 1 says levers run in lever order, then
runtime, then anomalies. Insert in the right group.

```typescript
// src/engine/index.ts
import { myRule } from "./rules/myRule";

export const ALL_RULES: readonly Rule[] = [
  // ...existing levers...
  // ...existing runtime rules...
  // ...existing anomaly rules...
  myRule,                                          // pick the right slot
] as const;
```

### 10. Test the rule

Two tests are mandatory. A third is strongly recommended.

**Mandatory: an isolation test.** Add a test in
`src/test/rules.test.ts` that hands the rule a small fixture invoice and
asserts the finding it returns. Use the existing tests as a template.
Cover both the positive case (rule fires) and the negative case (rule
returns null when no matching rows).

**Mandatory: a framework-invariant test** if your rule introduces a new
invariant. For example, when `sqlHybridBenefit.ts` was added, the test
"SQL Hybrid Benefit findings must have a range, not a point estimate"
went into `framework.test.ts`. If your rule does not introduce a new
invariant, the existing framework tests should cover it.

**Recommended: a smoke check.** Run `npm run engine:smoke` against the
bundled NMEF invoice and confirm the rule fires plausibly. The smoke
script writes the three audience reports to `out/`; eyeball the
Informational report to verify your narrative reads correctly.

```bash
npm test                  # all tests must pass
npm run engine:smoke      # generate the reports
open out/*informational.html
```

### 11. Verify the validator stays green

```bash
npm run engine:smoke 2>&1 | grep -i validation
```

If the validator surfaces issues for your rule, fix them before
shipping. Common causes:

- Evidence cost sum doesn't match the finding's claimed saving and the
  finding is not a range.
- Discovery question is missing on a non-confirmed-low-effort finding.
- The finding aggregates an `investigate` saving into the headline.
- A `sqlHybridBenefit:*` finding emits `monthlySaving` instead of
  `monthlySavingRange`.

---

## Updating an existing rule

The contract above still applies. Two extra rules of thumb:

1. **Don't change a rule's `id`** — finding IDs flow into customer CSVs
   and ticket systems. A rule whose ID changes silently breaks
   downstream consumers.
2. **Don't change the framework principle citation.** If the rule no
   longer maps to its principle, it is a different rule. Create a new
   one and deprecate the old.

Adding new SKU patterns, new meter names, new RG naming conventions, or
new severity classifications to an existing rule are all fine. Run the
tests and the smoke check after every meaningful change.

---

## Naming and tone in narratives

A few conventions caught from rule reviews. None of these are enforced
by code; all of them keep the report readable.

- **Customer narrative starts with the action stance.** The voice
  filter prepends "Worth doing now." / "Behind one decision." /
  "Worth a conversation." automatically — write the rest of the
  paragraph as if a human had already said that line.
- **Consultant narrative leads with the recommendation.** "Apply
  Hybrid Benefit via the VM blade" beats "Hybrid Benefit can be
  applied if the customer chooses to."
- **Informational narrative shows the math.** Number of evidence rows,
  the formula behind any range, the rate-table version cited, the
  validator invariants this finding obeys.
- **No personal attribution in user-facing prose.** The framework rules
  have a recorded source; the rule docstring may cite it for audit, but
  customer-facing strings say "FinOps Rule N" or "the framework", not
  the source's name. The voice filter will catch most slips.

---

## Example: a minimal rule

A toy rule that flags Premium Storage accounts in non-prod resource
groups, suggesting Standard LRS for downgrade. Real rule writers will
do more — this is the skeleton.

```typescript
// src/engine/rules/premiumStorageNonProd.ts
import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";
import { round2, formatMoney } from "./_helpers";
import { getFrameworkRule } from "../framework";

const NONPROD_HINTS = ["-dev-", "-test-", "-stage-", "dev_", "test_"];

function isNonProd(rgName: string): boolean {
  const lc = rgName.toLowerCase();
  return NONPROD_HINTS.some((h) => lc.includes(h));
}

function isPremiumStorage(r: InvoiceRow): boolean {
  return r.serviceName === "Storage" && /premium/i.test(r.meter);
}

export const premiumStorageNonProdRule: Rule = {
  id: "premiumStorageNonProd",
  name: "Premium Storage in non-prod resource groups",
  framework: {
    rule: 9,
    quote: getFrameworkRule(9).verbatimQuote,
  },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const matches = invoice.rows.filter(
      (r) => isPremiumStorage(r) && isNonProd(r.resourceGroupName),
    );
    if (matches.length === 0) return null;

    const total = round2(matches.reduce((s, r) => s + r.cost, 0));
    const evidence: EvidenceRow[] = matches.slice(0, 25).map((r) => ({
      resourceId: r.resourceId,
      meter: r.meter,
      cost: round2(r.cost),
      reason: `Premium Storage in non-prod RG ${r.resourceGroupName}`,
    }));

    return [{
      id: "premiumStorageNonProd",
      category: "anomaly",
      jeannieRule: 9,
      order: 1,
      title: `Premium Storage in non-prod (${matches.length} accounts, ${formatMoney(total, invoice.displayCurrency)})`,
      severity: "conditional",
      monthlySaving: null,
      annualSaving: null,
      monthlySavingRange: [round2(total * 0.4), round2(total * 0.7)],
      annualSavingRange: [round2(total * 0.4 * 12), round2(total * 0.7 * 12)],
      currency: invoice.displayCurrency,
      confidence: "medium",
      evidence,
      narrative: {
        customer:
          `Several non-production storage accounts are on a premium tier that costs more than necessary for non-customer-facing workloads. Standard storage covers most non-production cases at a lower price.`,
        consultant:
          `${matches.length} Premium Storage accounts in non-prod RGs total ${formatMoney(total, invoice.displayCurrency)} for the period. Recommend Standard LRS migration once IO patterns are confirmed. Apply via Storage Account → Configuration → Performance.`,
        informational:
          `Detection: Storage rows with Premium meter where resourceGroupName matches non-prod patterns (${NONPROD_HINTS.join(", ")}). Saving range of 40–70% reflects Standard vs Premium price spread; validator enforces range presence on conditional severity.`,
      },
      discoveryQuestions: [
        "Are these storage accounts serving any latency-sensitive workload that requires Premium IO?",
        "Is there a compliance requirement that pins these accounts to Premium?",
      ],
      effort: "medium",
      requiresConfirmation: [
        "Confirm IO requirements before downgrade",
        "Confirm no compliance pin to Premium",
      ],
    }];
  },
};
```

Then register it in `ALL_RULES` and write the test:

```typescript
// src/test/rules.test.ts (excerpt)
it("premiumStorageNonProd fires on Premium meters in non-prod RGs", () => {
  const invoice = fixtureInvoice([
    fixtureRow({ serviceName: "Storage", meter: "Premium SSD LRS", resourceGroupName: "rg-dev-eus", cost: 100 }),
  ]);
  const findings = premiumStorageNonProdRule.evaluate(invoice);
  expect(findings).not.toBeNull();
  expect(findings![0].severity).toBe("conditional");
  expect(findings![0].monthlySavingRange).toBeDefined();
  expect(findings![0].monthlySaving).toBeNull();
});
```

That's it. Run the tests, run the smoke, check the report renders with
your finding visible.

---

## See also

- [RULES.md](RULES.md) — the full rule reference.
- `src/engine/framework.ts` — the ten principles in code.
- `src/types/index.ts` — the Rule, Finding, and EvidenceRow type
  contracts.
- `src/engine/validate.ts` — every invariant that gets checked after
  evaluation. Read it once before adding your first rule.
